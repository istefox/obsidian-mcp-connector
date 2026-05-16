# Migration Plan

> **⚠️ HISTORICAL / SUPERSEDED (kept for reference).** This was the pre-0.4 reorganization plan; it references the now-removed `mcp-server` / `mcp-server-install` pieces. The 0.4.x in-process migration is **complete** — for the current architecture see [`docs/project-architecture.md`](project-architecture.md). Do not treat this as an active plan.

This document outlines the step-by-step plan to migrate the current codebase to the new project architecture.

## Phase 1: Project Structure Setup

### 1. Create Shared Package Structure
```
packages/shared/
├── src/
│   ├── types/
│   │   ├── settings.ts        # Base settings interface
│   │   ├── plugin.ts         # Plugin-related types
│   │   └── server.ts         # Server-related types
│   ├── utils/
│   │   ├── logger.ts         # Shared logging utilities
│   │   └── version.ts        # Version management utilities
│   └── constants/
       └── config.ts          # Shared configuration constants
```

Tasks:
- [ ] Move common types from plugin and server to shared/types
- [ ] Create base settings interface
- [ ] Extract shared utilities
- [ ] Set up shared tsconfig.json
- [ ] Update package.json dependencies

### 2. Reorganize Plugin Structure
```
packages/obsidian-plugin/
├── src/
│   ├── features/
│   │   ├── core/
│   │   │   ├── components/
│   │   │   ├── services/
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   ├── mcp-server-install/
│   │   │   ├── components/
│   │   │   ├── services/
│   │   │   │   └── download.ts
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   ├── mcp-server-prompts/
│   │   │   ├── components/
│   │   │   ├── services/
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   └── smart-search/
│   │       ├── components/
│   │       ├── services/
│   │       ├── types.ts
│   │       └── index.ts
│   └── main.ts
```

Tasks:
- [ ] Create feature module directories
- [ ] Move download.ts to mcp-server-install feature
- [ ] Move template handling to mcp-server-prompts feature
- [ ] Move smart search to smart-search feature
- [ ] Create core feature for plugin initialization
- [ ] Update imports and dependencies

### 3. Reorganize Server Structure
```
packages/mcp-server/
├── src/
│   ├── features/
│   │   ├── core/
│   │   │   ├── services/
│   │   │   │   └── server.ts
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   ├── prompts/
│   │   │   ├── services/
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   └── tools/
│   │       ├── services/
│   │       ├── types.ts
│   │       └── index.ts
│   └── index.ts
```

Tasks:
- [ ] Create feature module directories
- [ ] Move server.ts to core feature
- [ ] Move prompt handling to prompts feature
- [ ] Move tool handling to tools feature
- [ ] Update imports and dependencies

## Phase 2: Feature Implementation

### 1. Core Feature
Tasks:
- [ ] Implement plugin settings management
- [ ] Create PluginSettingTab with feature UI loading
- [ ] Set up version management system
- [ ] Implement consistent error handling

### 2. MCP Server Install Feature
Tasks:
- [ ] Refactor download functionality into service
- [ ] Add version checking
- [ ] Implement error handling and logging
- [ ] Create settings UI component

### 3. MCP Server Prompts Feature
Tasks:
- [ ] Implement prompt template management
- [ ] Add argument validation
- [ ] Create prompt execution service
- [ ] Add settings UI for prompt configuration

### 4. Smart Search Feature
Tasks:
- [ ] Refactor search functionality into service
- [ ] Implement proper error handling
- [ ] Add search settings management
- [ ] Create search UI components

## Phase 3: Build and Testing Setup

### 1. Build Configuration
Tasks:
- [ ] Set up shared tsconfig settings
- [ ] Configure ESBuild for plugin bundling
- [ ] Create build scripts for each package
- [ ] Set up version management through versions.json

### 2. Testing Environment
Tasks:
- [ ] Create playground environments for each package
- [ ] Set up test configurations
- [ ] Add example test files
- [ ] Create test documentation

## Phase 4: Documentation

### 1. Code Documentation
Tasks:
- [ ] Add JSDoc comments to all public APIs
- [ ] Create API documentation
- [ ] Document feature configurations
- [ ] Add usage examples

### 2. Development Documentation
Tasks:
- [ ] Create development setup guide
- [ ] Document build and test processes
- [ ] Add feature development guide
- [ ] Create troubleshooting guide

## Migration Strategy

1. **Preparation**
   - Create new directory structure
   - Set up build configurations
   - Create shared package

2. **Feature Migration**
   - Migrate one feature at a time
   - Start with core feature
   - Add tests for each feature
   - Maintain backwards compatibility

3. **Testing**
   - Test each migrated feature
   - Run integration tests
   - Verify plugin functionality
   - Test error handling

4. **Cleanup**
   - Remove old files
   - Update documentation
   - Verify all features working
   - Release new version

## Timeline Estimate

- Phase 1: 1-2 weeks
- Phase 2: 2-3 weeks
- Phase 3: 1 week
- Phase 4: 1 week

Total estimated time: 5-7 weeks

## Risk Management

1. **Compatibility Risks**
   - Maintain version checks
   - Test with different Obsidian versions
   - Keep fallback mechanisms

2. **Data Migration Risks**
   - Back up user settings
   - Provide migration utilities
   - Document upgrade process

3. **Performance Risks**
   - Monitor bundle size
   - Test with large vaults
   - Profile feature performance

## Success Criteria

1. All features working as before
2. Improved error handling
3. Better code organization
4. Comprehensive documentation
5. Full test coverage
6. Smooth upgrade path for users
