# Feature request: Loops CRUD API — expose WorkflowDefinition query + mutations

*Draft for Linear support / community Slack. Schema claims verified by live
introspection of api.linear.app/graphql on 2026-07-25.*

---

**Feature request: Loops CRUD API — expose WorkflowDefinition query + mutations**

The Loop schema is already fully modelled in the live GraphQL API. What's
missing is any path to reach it.

`WorkflowDefinition` is a complete entity with **34 fields**, including exactly
the ones the Loops UI edits — `name`, `groupName`, `description`, `icon`,
`color`, `type`, `trigger`, `triggerType`, `conditions`, `schedule`. Its
supporting types are all present too: `WorkflowTrigger`, `WorkflowTriggerType`,
`WorkflowCronJobDefinition`, `WorkflowDefinitionNotification`, `WorkflowType`.

This isn't a stub reserved for later. It's a finished type that nothing can
query.

**The gap, precisely:** `WorkflowDefinition` is unreachable from any query
root.

- No `workflowDefinitions` query. Of the 158 root queries, the only
  `workflow*` entries are `workflowStates` / `workflowState` — issue workflow
  states, unrelated to Loops.
- No traversal from `Team`. Of its 81 fields, the only `workflow*` one is
  `inheritWorkflowStatuses`.
- No mutations. The only `workflow*` mutations are `workflowStateCreate` /
  `Update` / `Archive` (again, issue states) and
  `integrationSlackWorkflowAccessUpdate`.

**Use case.** We maintain a versioned Loops recipe catalog in Git — 9 recipes
(`bug-triage-dispatcher`, `triage-debt-weekly-sweep`,
`project-update-synthesizer`, `carry-over-warning`, `plan-doc-drift-detector`,
and others) with YAML frontmatter mapping 1:1 onto `WorkflowDefinition` fields.
Today a human pastes each one into the Loops UI by hand.

With a CRUD surface we could:

1. `loops diff` — compare versioned recipes against published loops, detecting
   drift between what's in Git and what's actually running.
2. `loops apply` — create/update loops from those recipes. GitOps for Loops.
3. `loops enable/disable` — toggle programmatically, which matters for incident
   response when a loop is misfiring at 3am.

**The ask, in priority order.** A read-only `workflowDefinitions` query alone
would unlock (1), which is the highest-value piece — drift detection is what
turns a recipe catalog from documentation into something enforceable. Mutations
for (2) and (3) can follow.

The schema is done. This is the last mile.
