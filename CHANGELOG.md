# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `triggerfish changelog` command — view release notes between any two installed versions
- `triggerfish changelog <from>` — show all changes since a given version
- `triggerfish changelog <from> <to>` — show delta between two specific versions
- Post-update changelog display — automatically shows what changed after `triggerfish update`
- `scripts/gen_changelog_json.ts` — CI script that parses this file into `CHANGELOG.json`
- `CHANGELOG.json` is fetched from GitHub release assets and cached locally on update
