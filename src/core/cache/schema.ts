import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

/**
 * Normalized SQLite schema for linearctl's local ticket and entity cache.
 * Designed for sub-millisecond query execution, zero-copy reads, and full-text search.
 */

// 1. Teams
export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    displayName: text("display_name"),
    description: text("description"),
    createdAt: text("created_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_teams_key").on(table.key),
  ]
);

// 2. Users
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    displayName: text("display_name"),
    email: text("email"),
    active: integer("active", { mode: "boolean" }).default(true),
    createdAt: text("created_at"),
    updatedAt: text("updated_at"),
  },
  (table) => [
    index("idx_users_email").on(table.email),
  ]
);

// 3. Workflow States
export const workflowStates = sqliteTable(
  "workflow_states",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id"),
    name: text("name").notNull(),
    type: text("type").notNull(), // triage, backlog, unstarted, started, completed, canceled
    color: text("color"),
    position: real("position").default(0),
    createdAt: text("created_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_workflow_states_team").on(table.teamId),
    index("idx_workflow_states_type").on(table.type),
    index("idx_workflow_states_name").on(table.name),
  ]
);

// 4. Issue Labels
export const issueLabels = sqliteTable(
  "issue_labels",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id"),
    name: text("name").notNull(),
    color: text("color"),
    description: text("description"),
    createdAt: text("created_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_issue_labels_team").on(table.teamId),
    index("idx_issue_labels_name").on(table.name),
  ]
);

// 5. Projects
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slugId: text("slug_id"),
    state: text("state"),
    leadId: text("lead_id"),
    startDate: text("start_date"),
    targetDate: text("target_date"),
    createdAt: text("created_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_projects_name").on(table.name),
    index("idx_projects_slug").on(table.slugId),
  ]
);

// 6. Project Milestones
export const projectMilestones = sqliteTable(
  "project_milestones",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id"),
    name: text("name").notNull(),
    description: text("description"),
    targetDate: text("target_date"),
    status: text("status"),
    createdAt: text("created_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_project_milestones_project").on(table.projectId),
    index("idx_project_milestones_name").on(table.name),
  ]
);

// 7. Cycles
export const cycles = sqliteTable(
  "cycles",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id"),
    number: integer("number"),
    name: text("name"),
    startsAt: text("starts_at"),
    endsAt: text("ends_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_cycles_team").on(table.teamId),
    index("idx_cycles_number").on(table.number),
  ]
);

// 8. Issues (Core Entity)
export const issues = sqliteTable(
  "issues",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull().unique(), // e.g. CER-123
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").default(""),
    priority: integer("priority").default(0), // 0=None, 1=Urgent, 2=High, 3=Med, 4=Low
    priorityLabel: text("priority_label"),
    estimate: real("estimate"),
    teamId: text("team_id"),
    teamKey: text("team_key"),
    stateId: text("state_id"),
    stateName: text("state_name").notNull(),
    stateType: text("state_type").notNull(), // triage, backlog, unstarted, started, completed, canceled
    projectId: text("project_id"),
    projectName: text("project_name"),
    projectMilestoneId: text("project_milestone_id"),
    cycleId: text("cycle_id"),
    cycleNumber: integer("cycle_number"),
    assigneeId: text("assignee_id"),
    assigneeName: text("assignee_name"),
    creatorId: text("creator_id"),
    parentId: text("parent_id"),
    url: text("url").notNull(),
    branchName: text("branch_name"),
    dueDate: text("due_date"),
    labelsJson: text("labels_json").notNull().default("[]"), // array of label names e.g. ["bug", "core"]
    labelIdsJson: text("label_ids_json").notNull().default("[]"),
    trashed: integer("trashed", { mode: "boolean" }).default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    canceledAt: text("canceled_at"),
  },
  (table) => [
    index("idx_issues_identifier").on(table.identifier),
    index("idx_issues_team_key").on(table.teamKey),
    index("idx_issues_state_name").on(table.stateName),
    index("idx_issues_state_type").on(table.stateType),
    index("idx_issues_project_id").on(table.projectId),
    index("idx_issues_assignee_id").on(table.assigneeId),
    index("idx_issues_updated_at").on(table.updatedAt),
    index("idx_issues_created_at").on(table.createdAt),
    index("idx_issues_priority").on(table.priority),
    index("idx_issues_team_state_updated").on(table.teamKey, table.stateType, table.updatedAt),
  ]
);

// 9. Issue Relations
export const issueRelations = sqliteTable(
  "issue_relations",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(), // 'blocks' | 'blockedBy' | 'duplicate' | 'related'
    issueId: text("issue_id").notNull(),
    relatedIssueId: text("related_issue_id").notNull(),
    createdAt: text("created_at"),
    updatedAt: text("updated_at"),
  },
  (table) => [
    index("idx_issue_relations_issue").on(table.issueId),
    index("idx_issue_relations_related").on(table.relatedIssueId),
  ]
);

// 10. Cache Metadata
export const cacheMeta = sqliteTable(
  "cache_meta",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").notNull(),
  }
);

// Drizzle Relations
export const issuesRelations = relations(issues, ({ one }) => ({
  team: one(teams, {
    fields: [issues.teamId],
    references: [teams.id],
  }),
  state: one(workflowStates, {
    fields: [issues.stateId],
    references: [workflowStates.id],
  }),
  project: one(projects, {
    fields: [issues.projectId],
    references: [projects.id],
  }),
  assignee: one(users, {
    fields: [issues.assigneeId],
    references: [users.id],
  }),
}));

export type CachedIssue = typeof issues.$inferSelect;
export type InsertIssue = typeof issues.$inferInsert;
export type CachedTeam = typeof teams.$inferSelect;
export type CachedWorkflowState = typeof workflowStates.$inferSelect;
export type CachedIssueLabel = typeof issueLabels.$inferSelect;
export type CachedProject = typeof projects.$inferSelect;
export type CachedCycle = typeof cycles.$inferSelect;
export type CachedProjectMilestone = typeof projectMilestones.$inferSelect;
