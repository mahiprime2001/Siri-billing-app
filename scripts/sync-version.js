#!/usr/bin/env node

/**
 * Version Sync Validation Script
 * 
 * This script ensures that the version in package.json and src-tauri/tauri.conf.json
 * are always in sync. It can be run manually or as part of a pre-commit hook.
 * 
 * Usage:
 *   node scripts/sync-version.js --check    # Check if versions are in sync
 *   node scripts/sync-version.js --sync     # Sync package.json to tauri.conf.json
 *   node scripts/sync-version.js --help     # Show help
 */

const fs = require('fs');
const path = require('path');

const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');
const TAURI_CONFIG_PATH = path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json');

function readJsonFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`❌ Error reading ${filePath}:`, error.message);
    process.exit(1);
  }
}

function writeJsonFile(filePath, data) {
  try {
    const content = JSON.stringify(data, null, 2) + '\n';
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✅ Updated ${filePath}`);
  } catch (error) {
    console.error(`❌ Error writing ${filePath}:`, error.message);
    process.exit(1);
  }
}

function checkVersions() {
  const packageJson = readJsonFile(PACKAGE_JSON_PATH);
  const tauriConfig = readJsonFile(TAURI_CONFIG_PATH);

  const packageVersion = packageJson.version;
  const tauriVersion = tauriConfig.version;

  console.log('\n📦 Version Check:');
  console.log(`   package.json:        v${packageVersion}`);
  console.log(`   tauri.conf.json:     v${tauriVersion}`);

  if (packageVersion === tauriVersion) {
    console.log('\n✅ Versions are in sync!\n');
    return true;
  } else {
    console.log('\n❌ Versions are out of sync!\n');
    return false;
  }
}

function syncVersions() {
  const tauriConfig = readJsonFile(TAURI_CONFIG_PATH);
  const packageJson = readJsonFile(PACKAGE_JSON_PATH);

  const tauriVersion = tauriConfig.version;
  const oldPackageVersion = packageJson.version;

  if (oldPackageVersion === tauriVersion) {
    console.log('\n✅ Versions are already in sync!\n');
    return;
  }

  console.log('\n🔄 Syncing versions...');
  console.log(`   Source (tauri.conf.json): v${tauriVersion}`);
  console.log(`   Target (package.json):    v${oldPackageVersion} → v${tauriVersion}`);

  packageJson.version = tauriVersion;
  writeJsonFile(PACKAGE_JSON_PATH, packageJson);

  console.log('\n✅ Versions synced successfully!\n');
}

function showHelp() {
  console.log(`
📚 Version Sync Script - Help

Usage:
  node scripts/sync-version.js [option]

Options:
  --check     Check if versions are in sync (default)
  --sync      Sync package.json version to match tauri.conf.json
  --help      Show this help message

Examples:
  node scripts/sync-version.js --check
  node scripts/sync-version.js --sync

Description:
  This script helps maintain version consistency between package.json
  and src-tauri/tauri.conf.json. The Tauri config is considered the
  source of truth.
`);
}

// Main execution
const args = process.argv.slice(2);
const command = args[0] || '--check';

switch (command) {
  case '--check':
    const inSync = checkVersions();
    process.exit(inSync ? 0 : 1);
    break;

  case '--sync':
    syncVersions();
    break;

  case '--help':
  case '-h':
    showHelp();
    break;

  default:
    console.error(`❌ Unknown command: ${command}`);
    console.log('Run with --help for usage information.');
    process.exit(1);
}
