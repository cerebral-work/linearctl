#!/usr/bin/env bash
# scripts/cpm-wave-runner.sh
# linearctl CPM & Agent Sprint Wave Runner
# Implements wave strategies and invariants from soma-os, unsigned-paas, and cortex.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

MIN_RAM_MB=4000
NICE_LEVEL=19
HERDR_SOCK="${HOME}/.config/herdr/herdr.sock"
HERDR_LANE="estate/w1B:p6"
BLACKWALL_BIN="${HOME}/.local/bin/blackwall"

log_info() {
    echo "[INFO] $*"
}

log_pass() {
    echo "[PASS] $*"
}

log_warn() {
    echo "[WARN] $*" >&2
}

log_error() {
    echo "[ERROR] $*" >&2
}

check_preflight() {
    log_info "Starting preflight checks."

    # 1. Host memory check
    local avail_ram
    avail_ram=$(free -m | awk '/^Mem:/{print ($7 != "" ? $7 : $4)}')
    if [ "${avail_ram}" -lt "${MIN_RAM_MB}" ]; then
        log_error "Available memory (${avail_ram} MB) is below floor (${MIN_RAM_MB} MB)."
        return 1
    fi
    log_pass "Host memory floor satisfied: ${avail_ram} MB available."

    # 2. Git index lock check
    if [ -f "${REPO_ROOT}/.git/index.lock" ]; then
        log_error "Git lock detected at .git/index.lock. Aborting execution."
        return 1
    fi
    log_pass "No git index locks detected."

    # 3. Blackwall custody doctor
    if [ -x "${BLACKWALL_BIN}" ]; then
        if (cd "${REPO_ROOT}" && "${BLACKWALL_BIN}" doctor >/dev/null 2>&1); then
            log_pass "Blackwall custody doctor check passed."
        else
            log_warn "Blackwall doctor reported warnings. Proceeding with caution."
        fi
    elif command -v blackwall >/dev/null 2>&1; then
        if (cd "${REPO_ROOT}" && blackwall doctor >/dev/null 2>&1); then
            log_pass "Blackwall custody doctor check passed."
        fi
    else
        log_warn "Blackwall binary not found. Skipping blackwall doctor."
    fi

    # 4. Herdr socket check
    if [ -S "${HERDR_SOCK}" ]; then
        log_pass "Herdr socket active at ${HERDR_SOCK}."
    else
        log_warn "Herdr socket not active. Pane status cannot be verified automatically."
    fi

    return 0
}

check_path_disjointness() {
    log_info "Verifying task path disjointness."

    local wave1_paths="src/core/cache/"
    local wave2_paths="src/commands/relate.ts,src/commands/file.ts,src/commands/update.ts,src/commands/search.ts"
    local wave3_paths="test/,scripts/benchmark-cache.ts"

    IFS=',' read -ra W1 <<< "${wave1_paths}"
    IFS=',' read -ra W2 <<< "${wave2_paths}"
    IFS=',' read -ra W3 <<< "${wave3_paths}"

    for p1 in "${W1[@]}"; do
        for p2 in "${W2[@]}"; do
            if [ "${p1}" = "${p2}" ]; then
                log_error "Path overlap detected between Wave 1 and Wave 2: ${p1}"
                return 1
            fi
        done
        for p3 in "${W3[@]}"; do
            if [ "${p1}" = "${p3}" ]; then
                log_error "Path overlap detected between Wave 1 and Wave 3: ${p1}"
                return 1
            fi
        done
    done

    for p2 in "${W2[@]}"; do
        for p3 in "${W3[@]}"; do
            if [ "${p2}" = "${p3}" ]; then
                log_error "Path overlap detected between Wave 2 and Wave 3: ${p2}"
                return 1
            fi
        done
    done

    log_pass "Path disjointness confirmed across all waves."
    return 0
}

run_gate() {
    local cmd="$1"
    log_info "Running gate: ${cmd} (nice ${NICE_LEVEL})."
    (
        cd "${REPO_ROOT}"
        nice -n "${NICE_LEVEL}" bash -c "${cmd}"
    )
}

run_wave_0() {
    log_info "Executing Wave 0: Preflight and Baselines."
    check_preflight
    check_path_disjointness
    run_gate "bun run typecheck"
    run_gate "bun test test/agent-help.test.ts"
    log_pass "Wave 0 completed successfully."
}

run_wave_1() {
    log_info "Executing Wave 1: Core Cache and Funnel Invariants."
    log_info "Confined scope: src/core/cache/."
    run_gate "bun run typecheck"
    run_gate "bun test test/cache-*.test.ts"
    log_pass "Wave 1 completed successfully."
}

run_wave_2() {
    log_info "Executing Wave 2: CLI Commands and Relate Integration."
    log_info "Confined scope: src/commands/relate.ts, file.ts, update.ts, search.ts."
    run_gate "bun run typecheck"
    run_gate "bun test test/relate-cli.test.ts test/search.test.ts"
    log_pass "Wave 2 completed successfully."
}

run_wave_3() {
    log_info "Executing Wave 3: Verification, Benchmarking, and Land-on-Green."
    log_info "Confined scope: test/, scripts/benchmark-cache.ts."
    run_gate "bun run typecheck"
    run_gate "bun test"
    run_gate "bun run bench:cache"
    log_pass "Wave 3 completed successfully."
}

usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --wave <0|1|2|3|all>   Execute specified wave (default: all)"
    echo "  --check                Run preflight and disjointness verification only"
    echo "  --dry-run              Verify configuration without running gates"
    echo "  -h, --help             Show this help message"
}

main() {
    local target_wave="all"
    local dry_run=false
    local check_only=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --wave)
                target_wave="$2"
                shift 2
                ;;
            --check)
                check_only=true
                shift
                ;;
            --dry-run)
                dry_run=true
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                usage
                exit 1
                ;;
        esac
    done

    if [ "${check_only}" = true ]; then
        check_preflight
        check_path_disjointness
        log_pass "Check completed successfully."
        exit 0
    fi

    if [ "${dry_run}" = true ]; then
        log_info "Dry run enabled. Skipping compilation and test gates."
        check_preflight
        check_path_disjointness
        log_pass "Dry run completed successfully."
        exit 0
    fi

    case "${target_wave}" in
        0)
            run_wave_0
            ;;
        1)
            run_wave_1
            ;;
        2)
            run_wave_2
            ;;
        3)
            run_wave_3
            ;;
        all)
            run_wave_0
            run_wave_1
            run_wave_2
            run_wave_3
            log_pass "All sprint waves completed successfully."
            ;;
        *)
            log_error "Invalid wave: ${target_wave}. Valid options: 0, 1, 2, 3, all."
            exit 1
            ;;
    esac
}

main "$@"
