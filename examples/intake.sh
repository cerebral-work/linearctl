#!/usr/bin/env bash
# Example: linearctl intake ENG-123 --json
set -euo pipefail

# Emit an escapement PlanSubmission payload for a single issue
linearctl intake ENG-123 --json

# Evaluate a team's triage queue with a required eligibility label
linearctl intake --triage --team ENG --require-label agent-eligible --json
