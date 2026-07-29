# Roadmap — RINA private-cloud preview

> Rendered 2026-07-22 via `linearctl roadmap --project 'RINA private-cloud preview'`.
>
> Source project: https://linear.app/cerebral-work/project/rina-private-cloud-preview-10ad943fde6a

## Live Linear State (auto-rendered 2026-07-29 14:33 UTC)

| Milestone | Linear ID | Target Date | Issues | Progress |
|----------|-----------|------------|--------|----------|
| Core Stack Foundations | `4b699293-bea3-4ef5-951b-63bcdcc16340` | 2026-08-15 | 7 | 0% (0/7) |
| Private-Cloud Provisioning & Preview | `df4e1032-adcf-4099-a2a8-ad419de2d28e` | 2026-10-31 | 5 | 0% (0/5) |
| Host Stack & IPC Integration | `11cb48bf-a5d7-4c27-b63e-df8a661b3de6` | 2026-09-12 | 7 | 0% (0/7) |
| DMT Deployment Tooling | `6791238b-d13c-460c-a85a-86ea3532eb28` | 2026-10-03 | 5 | 0% (0/5) |

```
RINA private-cloud preview — 4 milestone(s)

  Core Stack Foundations  (due 2026-08-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/7
    RINA-27  [Backlog]  Write developer quickstart documentation
    RINA-26  [Backlog]  Author integration test harness for DIF-level round-trip traffic
    RINA-25  [Backlog]  Implement IPC manager daemon (enrollment + flow allocation)
    RINA-24  [Backlog]  Build normal-host network-stack shim (bind/connect/accept over IPC)
    RINA-23  [Canceled]  Implement IPC manager daemon (enrollment + flow allocation)
    RINA-22  [Canceled]  Author integration test harness for DIF-level round-trip traffic
    RINA-21  [Backlog]  Establish RINA DIF runtime build and CI pipeline

  Host Stack & IPC Integration  (due 2026-09-12)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/7
    RINA-34  [Backlog]  Harden enrollment: authentication, policy negotiation, retry
    RINA-33  [Backlog]  Validate end-to-end HTTP-over-RINA traffic in lab
    RINA-32  [Canceled]  Harden enrollment: authentication, policy negotiation, retry
    RINA-31  [Canceled]  Validate end-to-end HTTP-over-RINA traffic in lab
    RINA-30  [Backlog]  Add cross-DIF routing and relay-node support
    RINA-29  [Backlog]  Build RINA service-registry and name-resolution daemon
    RINA-28  [Backlog]  Implement socket-shim adapter for POSIX applications

  DMT Deployment Tooling  (due 2026-10-03)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/5
    RINA-39  [Backlog]  Integrate DMT with existing observability stack (Prometheus / Grafana)
    RINA-38  [Backlog]  Build automated node lifecycle: enroll, reconfigure, decommission
    RINA-37  [Backlog]  Add real-time node health and topology dashboard
    RINA-36  [Backlog]  Implement DMT agent (node bootstrap + config reconcile)
    RINA-35  [Backlog]  Design DMT CLI schema and node-configuration model

  Private-Cloud Provisioning & Preview  (due 2026-10-31)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/5
    RINA-44  [Backlog]  Publish preview-access guide and endpoint documentation
    RINA-43  [Backlog]  Produce live-demo runbook and operator SOP
    RINA-42  [Backlog]  Run load and soak validation against preview traffic
    RINA-41  [Backlog]  Deploy full multi-DIF fabric via DMT
    RINA-40  [Backlog]  Provision private-cloud bare-metal RINA nodes (Cygnus cluster)
```

*Last 7 days: 0 issue(s) touched, 0 completed.*
*Rendered by `.github/scripts/render-roadmap.sh` (corpus auto-render, schedule + dispatch).*

## Overview

The **RINA private-cloud preview** project delivers a runnable, demonstrable
RINA stack (Recursive InterNetwork Architecture) deployed into a private-cloud
environment. The roadmap progresses from core-stack foundations, through IPC
and host-stack integration, into DMT (Distributed Management Terminal)
deployment tooling, private-cloud provisioning automation, and culminates in a
live, operator-demoable preview.

## Milestones

### M1 — Core Stack Foundations
**Target: 2026-08-15**

Stand up the baseline RINA stack: the DIF (Distributed IPC Facility) runtime,
IPC manager, and normal-host shim. This is the load-bearing layer everything
else deploys on top of.

### M2 — Host Stack & IPC Integration
**Target: 2026-09-12**

Integrate the RINA host stack with real application workloads: socket-level
shims, service-registry, and cross-DIF routing. Prove end-to-end application
traffic over RINA.

### M3 — DMT Deployment Tooling
**Target: 2026-10-03**

The Distributed Management Terminal (DMT) provides declarative deployment and
lifecycle management for RINA nodes. This milestone delivers the tooling needed
to deploy, configure, and observe a multi-node RINA fabric.

### M4 — Private-Cloud Provisioning & Preview
**Target: 2026-10-31**

Provision the RINA fabric into the private-cloud environment (Cygnus / Vultr
bare metal), run the full stack under realistic load, and deliver a live
operator-demoable preview with documented runbooks.

---

## Rendered Roadmap

```
RINA private-cloud preview — 4 milestone(s)

  Core Stack Foundations  (due 2026-08-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/7
    RINA-27  [Backlog]  Write developer quickstart documentation
    RINA-26  [Backlog]  Author integration test harness for DIF-level round-trip traffic
    RINA-25  [Backlog]  Implement IPC manager daemon (enrollment + flow allocation)
    RINA-24  [Backlog]  Build normal-host network-stack shim (bind/connect/accept over IPC)
    RINA-23  [Canceled]  Implement IPC manager daemon (enrollment + flow allocation)
    RINA-22  [Canceled]  Author integration test harness for DIF-level round-trip traffic
    RINA-21  [Backlog]  Establish RINA DIF runtime build and CI pipeline

  Host Stack & IPC Integration  (due 2026-09-12)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/7
    RINA-34  [Backlog]  Harden enrollment: authentication, policy negotiation, retry
    RINA-33  [Backlog]  Validate end-to-end HTTP-over-RINA traffic in lab
    RINA-32  [Canceled]  Harden enrollment: authentication, policy negotiation, retry
    RINA-31  [Canceled]  Validate end-to-end HTTP-over-RINA traffic in lab
    RINA-30  [Backlog]  Add cross-DIF routing and relay-node support
    RINA-29  [Backlog]  Build RINA service-registry and name-resolution daemon
    RINA-28  [Backlog]  Implement socket-shim adapter for POSIX applications

  DMT Deployment Tooling  (due 2026-10-03)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/5
    RINA-39  [Backlog]  Integrate DMT with existing observability stack (Prometheus / Grafana)
    RINA-38  [Backlog]  Build automated node lifecycle: enroll, reconfigure, decommission
    RINA-37  [Backlog]  Add real-time node health and topology dashboard
    RINA-36  [Backlog]  Implement DMT agent (node bootstrap + config reconcile)
    RINA-35  [Backlog]  Design DMT CLI schema and node-configuration model

  Private-Cloud Provisioning & Preview  (due 2026-10-31)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/5
    RINA-44  [Backlog]  Publish preview-access guide and endpoint documentation
    RINA-43  [Backlog]  Produce live-demo runbook and operator SOP
    RINA-42  [Backlog]  Run load and soak validation against preview traffic
    RINA-41  [Backlog]  Deploy full multi-DIF fabric via DMT
    RINA-40  [Backlog]  Provision private-cloud bare-metal RINA nodes (Cygnus cluster)
```

## Issue Inventory

20 active issues across 4 milestones (4 canceled duplicates excluded from
active count):

| Milestone | Issues | Identifier Range |
|-----------|--------|-----------------|
| Core Stack Foundations | 5 active (RINA-21, 24, 25, 26, 27) | RINA-21–27 |
| Host Stack & IPC Integration | 5 active (RINA-28, 29, 30, 33, 34) | RINA-28–34 |
| DMT Deployment Tooling | 5 active (RINA-35–39) | RINA-35–39 |
| Private-Cloud Provisioning & Preview | 5 active (RINA-40–44) | RINA-40–44 |

**Canceled duplicates** (created during rate-limit retries, then canceled):
- RINA-22 (dup of RINA-26), RINA-23 (dup of RINA-25)
- RINA-31 (dup of RINA-33), RINA-32 (dup of RINA-34)

---

*Generated by `linearctl` on 2026-07-22. Re-render with:*
```bash
LINEAR_API_KEY='op://...' op run -- bun run dev -- roadmap --project 'RINA private-cloud preview'
```
