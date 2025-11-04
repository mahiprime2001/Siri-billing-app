# Version Management Guide

## Overview

The Siri Billing App maintains version synchronization between:
- `package.json` (Next.js app version)
- `src-tauri/tauri.conf.json` (Tauri app version)

**Source of Truth:** `src-tauri/tauri.conf.json`

## Current Version

The app displays the current version in the bottom-left corner of the UI.

## Version Synchronization

### Automatic Sync (CI/CD)

The GitHub Actions workflow automatically:
1. Increments the patch version in `tauri.conf.json`
2. Updates `package.json` to match
3. Commits both files with `[skip ci]` tag
4. Creates a new release

**Workflow File:** `.github/workflows/release.yml`

### Manual Sync

#### Check Version Sync Status

```bash
npm run version:check
```

This will display:
```
📦 Version Check:
   package.json:        v1.0.28
   tauri.conf.json:     v1.0.28

✅ Versions are in sync!
```

#### Sync Versions Manually

```bash
npm run version:sync
```

This syncs `package.json` to match `tauri.conf.json`.

### Manual Version Update

When manually updating the version:

1. **Update Tauri config first:**
   ```json
   // src-tauri/tauri.conf.json
   {
     "version": "1.0.29"
   }
   ```

2. **Sync package.json:**
   ```bash
   npm run version:sync
   ```

3. **Verify sync:**
   ```bash
   npm run version:check
   ```

## Version Display in UI

The version is displayed in two places:

1. **Bottom-left corner** (always visible)
   - Shows: `v1.0.28`
   - Location: `app/layout.tsx`
   - Source: `package.json`

2. **Update notifications** (when update available)
   - Shows new version in update dialog
   - Location: `components/Updater.tsx`

## Version Format

Format: `MAJOR.MINOR.PATCH`

- **MAJOR:** Breaking changes (e.g., 1.0.0 → 2.0.0)
- **MINOR:** New features (e.g., 1.0.0 → 1.1.0)
- **PATCH:** Bug fixes (e.g., 1.0.0 → 1.0.1)

### Constraints

Windows MSI installer limits:
- Major: 0-255
- Minor: 0-255
- Patch: 0-65535

## GitHub Workflow

### Automatic Release Process

1. Push to `main` branch
2. Workflow auto-increments patch version
3. Updates both `package.json` and `tauri.conf.json`
4. Builds Windows app
5. Creates GitHub release with tag `v{version}`
6. Uploads installers and `latest.json`
7. Marks release as "Latest"

### Workflow Trigger

```yaml
on:
  push:
    branches:
      - main
    paths-ignore:
      - 'src-tauri/tauri.conf.json'
  workflow_dispatch:
```

### Version Bump Logic

```powershell
# Read current version
$currentVer = "1.0.28"

# Increment patch
$newVer = "1.0.29"

# Update both files
tauri.conf.json → version: "1.0.29"
package.json    → version: "1.0.29"
```

## Updater Configuration

### Endpoint

```json
{
  "plugins": {
    "updater": {
      "active": true,
      "endpoints": [
        "https://github.com/mahiprime2001/Siri-billing-app/releases/latest/download/latest.json"
      ]
    }
  }
}
```

### Update Flow

1. App checks for updates on startup
2. Compares current version with `latest.json`
3. Shows update dialog if newer version available
4. Downloads and installs update
5. Restarts app automatically

## Troubleshooting

### Versions Out of Sync

**Problem:** `package.json` and `tauri.conf.json` have different versions

**Solution:**
```bash
npm run version:sync
```

### Update Not Detected

**Problem:** New release created but app doesn't detect update

**Checklist:**
1. Verify `latest.json` exists in latest release
2. Check version format matches (no 'v' prefix in JSON)
3. Ensure updater endpoint is correct
4. Check console for updater errors

### Build Fails with Version Error

**Problem:** MSI version out of range

**Solution:** Version must be ≤ 255.255.65535
```json
{
  "version": "1.0.29"  // ✅ Valid
  "version": "256.0.0" // ❌ Invalid (major > 255)
}
```

## Scripts Reference

| Command | Description |
|---------|-------------|
| `npm run version:check` | Check if versions are in sync |
| `npm run version:sync` | Sync package.json to tauri.conf.json |

## Files Involved

- `package.json` - Next.js app version
- `src-tauri/tauri.conf.json` - Tauri app version (source of truth)
- `app/layout.tsx` - Version display in UI
- `components/Updater.tsx` - Update checker and installer
- `.github/workflows/release.yml` - Auto-versioning workflow
- `scripts/sync-version.js` - Version sync utility

## Best Practices

1. ✅ **Always update `tauri.conf.json` first**
2. ✅ **Run `npm run version:sync` after manual version changes**
3. ✅ **Verify sync with `npm run version:check` before committing**
4. ✅ **Let CI/CD handle version bumps for releases**
5. ❌ **Don't manually edit both files separately**
6. ❌ **Don't skip version sync validation**

## Example Workflow

### Making a Release

```bash
# 1. Make your changes
git add .
git commit -m "feat: add new feature"

# 2. Push to main (CI handles versioning)
git push origin main

# 3. GitHub Actions will:
#    - Bump version to 1.0.29
#    - Update both JSON files
#    - Build and release
#    - Create installers
```

### Manual Version Update

```bash
# 1. Edit src-tauri/tauri.conf.json
# Change version to "1.1.0"

# 2. Sync package.json
npm run version:sync

# 3. Verify
npm run version:check

# 4. Commit
git add package.json src-tauri/tauri.conf.json
git commit -m "chore: bump version to 1.1.0"
git push
```
