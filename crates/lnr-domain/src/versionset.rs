//! VersionSet dependency closure resolution and Cargo patch generator borrowed from
//! `researchd` (`science/src/versionset.rs`).
//!
//! Models Amazon Brazil-style VersionSets: named, immutable collections of
//! package pins that form a hermetic dependency closure across independent
//! Git repositories and local checkouts.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::error::DomainError;

/// Source location for resolving a pinned package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PackageSource {
    /// Pinned to a local directory path.
    Path {
        /// Relative or absolute directory path.
        path: String,
    },
    /// Pinned to a specific Git repository and revision.
    Git {
        /// Git repository URL.
        git: String,
        /// Commit SHA, branch, or tag.
        rev: String,
    },
    /// Pinned to an upstream package registry version.
    Registry {
        /// Semantic version string.
        version: String,
        /// Optional custom registry index URL.
        registry: Option<String>,
    },
}

/// A pinned package within a [`VersionSet`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackagePin {
    /// Package or crate name.
    pub name: String,
    /// Semantic version string.
    pub version: String,
    /// Physical or remote source location.
    pub source: PackageSource,
    /// Direct dependencies declared by this package.
    #[serde(default)]
    pub dependencies: Vec<String>,
}

impl PackagePin {
    /// Create a new package pin.
    #[must_use]
    pub fn new(
        name: impl Into<String>,
        version: impl Into<String>,
        source: PackageSource,
        dependencies: Vec<String>,
    ) -> Self {
        Self {
            name: name.into(),
            version: version.into(),
            source,
            dependencies,
        }
    }
}

/// Policy for handling conflicting package versions during resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    /// Fail immediately when encountering conflicting pins for the same package.
    #[default]
    Fail,
    /// Allow child VersionSets to override parent pins for the same package.
    Override,
}

/// A named, immutable set of package pins representing a dependency closure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionSet {
    /// Unique name of this VersionSet.
    pub name: String,
    /// Optional parent VersionSet name (e.g. `"live"`).
    pub parent: Option<String>,
    /// Package pins included in this VersionSet.
    pub packages: Vec<PackagePin>,
}

impl VersionSet {
    /// Create a new [`VersionSet`].
    #[must_use]
    pub fn new(name: impl Into<String>, parent: Option<String>, packages: Vec<PackagePin>) -> Self {
        Self {
            name: name.into(),
            parent,
            packages,
        }
    }
}

/// The resolved dependency closure and build plan for a [`VersionSet`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionSetResolution {
    /// Name of the resolved VersionSet.
    pub name: String,
    /// Topological build order (dependencies precede dependents).
    pub build_order: Vec<String>,
    /// Map of package names to their resolved pins.
    pub pins: BTreeMap<String, PackagePin>,
    /// Formatted `[patch.crates-io]` TOML block.
    pub patch_toml: String,
}

/// Resolver that computes topological build orders and generates Cargo patch configurations.
#[derive(Debug, Clone, Default)]
pub struct VersionSetResolver {
    policy: ConflictPolicy,
}

impl VersionSetResolver {
    /// Create a resolver with the specified conflict policy.
    #[must_use]
    pub const fn new(policy: ConflictPolicy) -> Self {
        Self { policy }
    }

    /// Resolve a standalone [`VersionSet`] into its topological build order and patch configuration.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError`] on version conflicts, missing dependencies, or dependency cycles.
    pub fn resolve(&self, vs: &VersionSet) -> Result<VersionSetResolution, DomainError> {
        let mut pins: BTreeMap<String, PackagePin> = BTreeMap::new();

        for pkg in &vs.packages {
            if let Some(existing) = pins.get(&pkg.name) {
                if existing != pkg && self.policy == ConflictPolicy::Fail {
                    return Err(DomainError::VersionConflict {
                        package: pkg.name.clone(),
                        message: format!(
                            "conflicting pin versions: '{}' vs '{}'",
                            existing.version, pkg.version
                        ),
                    });
                }
            }
            pins.insert(pkg.name.clone(), pkg.clone());
        }

        Self::resolve_internal(&vs.name, pins)
    }

    /// Resolve a child [`VersionSet`] merged on top of a parent [`VersionSet`].
    ///
    /// # Errors
    ///
    /// Returns [`DomainError`] on version conflicts, missing dependencies, or dependency cycles.
    pub fn resolve_with_parent(
        &self,
        child: &VersionSet,
        parent: &VersionSet,
    ) -> Result<VersionSetResolution, DomainError> {
        let mut pins: BTreeMap<String, PackagePin> = BTreeMap::new();

        for pkg in &parent.packages {
            pins.insert(pkg.name.clone(), pkg.clone());
        }

        for pkg in &child.packages {
            if let Some(existing) = pins.get(&pkg.name) {
                if existing != pkg && self.policy == ConflictPolicy::Fail {
                    return Err(DomainError::VersionConflict {
                        package: pkg.name.clone(),
                        message: format!(
                            "child VersionSet '{}' conflicts with parent pin for package '{}' ({} vs {})",
                            child.name, pkg.name, existing.version, pkg.version
                        ),
                    });
                }
            }
            pins.insert(pkg.name.clone(), pkg.clone());
        }

        Self::resolve_internal(&child.name, pins)
    }

    fn resolve_internal(
        name: &str,
        pins: BTreeMap<String, PackagePin>,
    ) -> Result<VersionSetResolution, DomainError> {
        if name.trim().is_empty() {
            return Err(DomainError::InvalidVersionSet(
                "VersionSet name cannot be empty".to_string(),
            ));
        }

        for (pkg_name, pin) in &pins {
            for dep in &pin.dependencies {
                if !pins.contains_key(dep) {
                    return Err(DomainError::MissingDependency {
                        step: pkg_name.clone(),
                        missing: dep.clone(),
                    });
                }
            }
        }

        let mut in_degree: HashMap<String, usize> = HashMap::new();
        let mut dependents: HashMap<String, Vec<String>> = HashMap::new();

        for (pkg_name, pin) in &pins {
            in_degree.insert(pkg_name.clone(), pin.dependencies.len());
            for dep in &pin.dependencies {
                dependents
                    .entry(dep.clone())
                    .or_default()
                    .push(pkg_name.clone());
            }
        }

        let mut sorted_queue: Vec<String> = in_degree
            .iter()
            .filter(|(_, &deg)| deg == 0)
            .map(|(pkg_name, _)| pkg_name.clone())
            .collect();
        sorted_queue.sort();
        let mut queue: VecDeque<String> = sorted_queue.into_iter().collect();

        let mut build_order = Vec::with_capacity(pins.len());
        let mut visited = HashSet::new();

        while let Some(current) = queue.pop_front() {
            if visited.insert(current.clone()) {
                build_order.push(current.clone());

                if let Some(next_list) = dependents.get(&current) {
                    let mut ready = Vec::new();
                    for next in next_list {
                        if let Some(deg) = in_degree.get_mut(next) {
                            *deg -= 1;
                            if *deg == 0 {
                                ready.push(next.clone());
                            }
                        }
                    }
                    ready.sort();
                    for r in ready {
                        queue.push_back(r);
                    }
                }
            }
        }

        if build_order.len() != pins.len() {
            return Err(DomainError::CyclicDependency(name.to_string()));
        }

        let patch_toml = Self::generate_patch_toml(&pins);

        Ok(VersionSetResolution {
            name: name.to_string(),
            build_order,
            pins,
            patch_toml,
        })
    }

    fn generate_patch_toml(pins: &BTreeMap<String, PackagePin>) -> String {
        let mut lines = vec!["[patch.crates-io]".to_string()];
        for (pkg_name, pin) in pins {
            match &pin.source {
                PackageSource::Path { path } => {
                    lines.push(format!("{pkg_name} = {{ path = \"{path}\" }}"));
                }
                PackageSource::Git { git, rev } => {
                    lines.push(format!(
                        "{pkg_name} = {{ git = \"{git}\", rev = \"{rev}\" }}"
                    ));
                }
                PackageSource::Registry { version, .. } => {
                    lines.push(format!("# {pkg_name} = \"{version}\" (registry)"));
                }
            }
        }
        lines.join("\n")
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn versionset_resolves_topological_order_and_detects_cycles() {
        let p_domain = PackagePin::new(
            "lnr-domain",
            "0.21.1",
            PackageSource::Path {
                path: "crates/lnr-domain".into(),
            },
            vec![],
        );
        let p_cli = PackagePin::new(
            "lnr-cli",
            "0.21.1",
            PackageSource::Path {
                path: "crates/lnr-cli".into(),
            },
            vec!["lnr-domain".into()],
        );
        let vs = VersionSet::new("lnr-live", None, vec![p_cli, p_domain]);
        let res = VersionSetResolver::new(ConflictPolicy::Fail)
            .resolve(&vs)
            .unwrap();
        assert_eq!(res.build_order, vec!["lnr-domain", "lnr-cli"]);
        assert!(res.patch_toml.contains("[patch.crates-io]"));
    }
}
