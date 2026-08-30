# Editable Scope Document Preview Design

## Goal

Allow users to review and edit scope extracted from an authorization file, then append the resulting entries to the existing manual authorization scope field.

## User Experience

After a scope document is parsed, the start-run modal displays its normalized scope in a read-only text area. The existing confirmation checkbox is replaced with two buttons:

- **Modify** enables direct editing of the comma-separated scope text.
- **Add** appends the current preview text to the end of the manual authorization scope field.

Adding uses comma-separated entries, preserves their first-seen order, and removes duplicates already present in either the manual field or the preview. After a successful add, the parsed preview and file input are cleared so the same file can be selected again.

The preview remains read-only until Modify is clicked. Add is available for the original parsed result as well as an edited result.

## Submission Semantics

The Web form treats added document content as manual scope. It does not send `scopeDocumentId` or `confirmedDocumentScope` after promotion into the manual field. The backend's exact document-confirmation API remains unchanged for other clients.

Uploading a file alone does not satisfy pentest scope validation. A pentest user must click Add or enter scope manually before starting. The existing optional empty-scope behavior for CTF tasks is unchanged.

## Component State

`StartRunModal` keeps:

- the parsed document response;
- one editable preview string initialized from `normalizedScope`;
- whether preview editing is enabled;
- a ref to the file input so it can be reset after Add or modal reset.

Selecting another file resets the previous preview state before parsing. Closing the modal or completing a run also resets document and edit state.

## Error Handling

Empty edited preview text cannot be added. Scope syntax continues to be authoritatively normalized and validated by the existing server when the run starts. Parse errors continue to use the existing alert.

## Localization

Add Chinese and English labels for Modify and Add. Remove the confirmation-checkbox label from this component; retaining an unused translation key is unnecessary.

## Tests

Component tests cover:

1. Parsed scope appears in a read-only text area.
2. Modify enables editing.
3. Add appends edited entries to an existing manual scope, removes duplicates, and clears the preview.
4. Added scope submits without document-confirmation fields.
5. Uploading without Add does not satisfy pentest validation.
6. Existing CTF empty-scope and manual-scope behavior remains unchanged.

