# Tool error codes

Every failed tool call returns an ordinary MCP result with `isError: true`. Its single text
block is a compact JSON body:

```json
{ "error": "File not found: Notes/idea.md", "errorCode": "file_not_found", "path": "Notes/idea.md" }
```

- `error` is the human-readable message. Its wording may change between releases; do not
  pattern-match on it.
- `errorCode` is a stable `snake_case` word. Branch on this.
- Any further field is context for that code (`path`, `tool`, `candidates`, `retryAfterSeconds`,
  …) and is listed per code below.

The envelope is built by one helper, `errorJson` in
`packages/obsidian-plugin/src/features/mcp-tools/services/responseBuilders.ts`; a tool never
hand-rolls it. Before adding a code, reuse one from this list.

## Paths and files

| Code | Meaning | Extra fields |
| --- | --- | --- |
| `file_not_found` | The path resolves to nothing. For a hidden folder (ADR-0020) the refusal is this same code, indistinguishable from a path that never existed. | `path` |
| `not_a_file` | The path is a folder where a file was required. | `path` |
| `not_a_directory` | The path is a file where a directory was required. | `path` |
| `folder_not_found` | A directory (or a destination's parent directory) does not exist. | `path` |
| `directory_not_empty` | A non-recursive directory delete hit contents. | `path` |
| `already_exists` | The destination of a rename or create is taken. | `path` |
| `file_exists` | `execute_template`'s `targetPath` already exists; the tool never overwrites. | `path` |
| `same_path` | Rename source and destination are identical. | `from`, `to` |
| `invalid_path` | The path normalises to the vault root, which the tool refuses to act on. | `path` |
| `not_markdown` | A frontmatter or heading patch was aimed at a non-`.md` file. | `path`, `targetType` |
| `no_active_file` | The `*_active_file` tool found no active editor file. | |
| `permission_denied` | The file system refused the operation. | `path` |
| `delete_failed`, `rename_failed` | The underlying Obsidian call threw; `error` carries its message. | `path` / `from`, `to` |
| `stale_precondition` | The file no longer matches the caller's `expectedContent` (ADR-0019, ADR-0022), or for `set_task_status` the task text differs from `expectedText`. | `targetType`, `target` or the read tool to re-check with |
| `write_failed` | `set_task_status`'s atomic `vault.process` threw; `error` carries its message. | `path`, `line` |

## Note anatomy

| Code | Meaning | Extra fields |
| --- | --- | --- |
| `heading_not_found` | No heading matches the target. | `path`, `target` or `heading` |
| `ambiguous_heading` | More than one heading matches; narrow the target. `rename_heading` adds the candidates. | `candidates` (`rename_heading`), `path`, `target` |
| `ambiguous_section` | The heading has no H1 parent while the file has an H1 elsewhere, so its section end is undefined. Pass `allowRootHeadings: true`. | `targetType`, `target` |
| `heading_collision` | `rename_heading`'s new text already exists at the same level. | |
| `source_write_failed` | `rename_heading` found the source file changed between plan and apply, or its write threw; nothing else was touched. | `path` |
| `partial_failure` | `rename_heading` updated the source but some backlinker writes failed, or `rename_tag` could not write some files; both lists are returned. | `updatedFiles`, `failedFiles`, `linkRewriteCount` / `details`, `failedFiles` |
| `no_headings`, `no_frontmatter` | `get_vault_file_partial` found nothing of that kind in the file. | `path` |
| `frontmatter_unparsable` | A frontmatter block exists but Obsidian's cache exposed no fields (YAML error). | `path` |
| `property_not_found` | The frontmatter key is absent. | `path`, `key` |
| `invalid_key` | The frontmatter key contains `:`, a newline or a leading `#`. | `key` |
| `type_mismatch` | A frontmatter `replace` would overwrite an array with a scalar or vice versa. | `targetType`, `target` |
| `block_not_found` | No block carries that id. | `path`, `blockId` or `target` |
| `invalid_block_id` | The block target is not a valid id. | `target` |
| `block_not_patchable` | The block sits inside a table or fenced code block. | `targetType`, `target` |
| `patch_failed` | A patch failure with no more specific code. | `targetType`, `target` |
| `not_a_task` | `set_task_status` was pointed at a line that is not a `- [ ]`-style task. | `path`, `line` |
| `line_out_of_range` | `set_task_status`'s `line` is past the end of the file. | `path`, `line`, `lineCount` |

## Arguments and queries

| Code | Meaning | Extra fields |
| --- | --- | --- |
| `invalid_params` | The arguments failed schema validation, carry an undeclared key, or a required argument for the chosen mode is missing. | `tool`, or `mode` |
| `invalid_arguments`, `too_many_paths`, `missing_argument` | Tool-specific argument refusals (`get_vault_files`, canvas tools). | per tool |
| `invalid_query` | `search_vault`'s JsonLogic query is not valid JSON. | |
| `invalid_regex`, `unsafe_regex` | `search_and_replace`'s pattern does not compile, or has nested quantifiers (ReDoS guard). | `pattern`, `flags` |
| `invalid_tag` | The tag is empty after stripping `#`, or (`rename_tag`) uses characters outside letters, digits, `_`, `-`, `/`, or is all digits. | `tag` |
| `invalid_base64` | `create_vault_binary_file`'s content does not decode. | `path` |
| `invalid_date_for_period` | The periodic-note date does not match the period's format or is not a real date. | `period`, `date` |
| `invalid_node_type`, `node_not_found`, `canvas_not_found`, `malformed_canvas`, `embed_target_not_found` | Canvas tool refusals. `update_canvas_node` also answers `invalid_params` with `fields` and `nodeType` when a content field does not belong to the node's type. | `path`, `nodeId`, `fields`, `nodeType` |
| `url_rejected` | `fetch` refused the URL (scheme, loopback, private range). | `url` |

## Tool surface and policy

| Code | Meaning | Extra fields |
| --- | --- | --- |
| `unknown_tool` | `activate_tool` was given a name no tool has. | `tool` |
| `tool_inactive` | The tool exists but is not in the caller's active set; call `activate_tools` and retry (ADR-0011). | `tool` |
| `not_allowed` | The token's allowed-tools list excludes the tool; only the vault owner can change that (ADR-0014). | `tool` |
| `tool_disabled` | The user switched the tool off in the plugin settings; MCP cannot re-enable it. | `tool` |
| `disabled_by_hidden_folders` | The tool is off while a hidden-folder policy is active (ADR-0020). | `tool` |
| `command_denied`, `command_not_found`, `rate_limited` | `execute_obsidian_command` refusals; `rate_limited` says when to retry. | `commandId` / `retryAfterSeconds` |

## Providers and plugins

| Code | Meaning | Extra fields |
| --- | --- | --- |
| `dataview_not_installed`, `dataview_not_ready`, `dataview_query_failed` | Dataview is missing, still indexing, or rejected the query. | `query` |
| `templater_not_installed`, `template_not_found`, `template_execution_failed`, `core_templates_execution_failed` | `execute_template` refusals. | `path` |
| `semantic_search_unavailable`, `semantic_search_failed`, `index_building` | `search_vault_smart`: no provider, provider threw, or the index is still being built (with progress fields). | `filesIndexed`, `filesTotal`, `percent`, `retryAfterSeconds` |
| `fetch_timeout`, `fetch_failed` | `fetch` timed out or the request threw. | `url`, `timeoutMs` |

## Transport-level

| Code | Meaning | Extra fields |
| --- | --- | --- |
| `invalid_request` | A `ProtocolError` with that code reached the dispatcher, including `Unknown tool: <name>` for a name that is unregistered or user-disabled. | `tool` |
| `method_not_found` | A `ProtocolError` with that code reached the dispatcher. | `tool` |
| `internal_error` | A handler threw something unexpected; the operator log has the stack. | `tool` |

## History

Up to 2.7.0 the surface had three shapes: this JSON body, a plain text message with no code,
and `rename_heading`'s own body keyed `message` with kebab-case codes (`heading-not-found`,
`ambiguous-heading`, `heading-collision`, `partial-failure`, `source-write-failed`,
`file-not-found`). Those six are now the snake_case words above, the key is `error`, and every
plain-text error carries a code. A client that matched on exact message text should switch to
`errorCode`.
