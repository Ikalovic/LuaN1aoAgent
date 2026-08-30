# Skill Management View Design

## Goal

Add a first-class Skills view to the Web workbench so authenticated users can inspect the project-local Skill registry and authorized operators can enable or disable individual Skills without calling the API manually.

## Scope

- Add `skills` as a top-level workbench view and a left-navigation item.
- Load the registry independently of the selected runtime session through `GET /api/skills`.
- Show total, enabled, invalid, and diagnostic counts.
- Support local name/description search and status filtering.
- Show each Skill's name, description, validity, model-invocation state, and enabled state in a compact table.
- Allow `admin` users to update enabled state through `POST /api/skills/:name/state`.
- Keep the view read-only for `analyst` users.
- Preserve the existing API contract and backend authorization checks.

## UI Structure

The left navigation gains a `Skills` item with a familiar tool icon. Selecting it updates the existing `view` URL parameter and displays the management view in the main workspace.

The view contains an unframed summary band, a compact search/filter toolbar, and one table. It does not depend on runtime state and remains useful when no run exists. The standard runtime controls remain available in the top bar for consistency, while the inspector shows a short explanation of Skill selection and enablement instead of graph details.

Each row uses status tags for validity and model invocation. The enabled state uses a `Switch`, because it is a binary setting. Analysts see the same switch disabled with a tooltip explaining that operator permission is required.

## Data Flow

`SkillsView` owns list loading and mutation state. Small API helpers and explicit TypeScript response types are added to the existing API and type modules.

On entry, the component fetches the latest registry snapshot. A successful state mutation replaces the matching row with the server response and then refreshes the registry snapshot so diagnostics and summary counts remain authoritative. Only the affected switch is disabled while its request is in flight.

## Errors And Empty States

- Initial load shows a stable spinner without shifting the table layout.
- Load failures show an inline retryable error.
- Mutation failures leave the previous row state unchanged and show an inline error.
- An empty registry shows a direct empty state pointing to `.agents/skills`.
- Invalid Skills remain visible but cannot be enabled from the UI.
- Registry diagnostics appear in a compact warning section without exposing unrelated runtime data.

## Localization And Responsiveness

All visible labels are added to the existing Chinese and English translation maps. On narrow screens the table scrolls horizontally and descriptions wrap; controls do not overlap or resize the surrounding layout.

## Testing

Frontend tests cover:

- navigation to the Skills view;
- loading and rendering registry rows and summary counts;
- search and status filtering;
- successful administrator state changes;
- analyst read-only behavior;
- load and mutation failures.

API helper tests verify request paths, JSON bodies, and CSRF-protected mutation behavior. Existing backend API tests remain the contract test for authentication and authorization.

## Non-Goals

- Installing, updating, or deleting Skill files from the Web UI.
- Editing `SKILL.md` content.
- Changing automatic per-Task Skill selection.
- Adding source repository metadata that the current registry does not expose.
