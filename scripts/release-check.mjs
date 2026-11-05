#!/usr/bin/env node
// Validates a release tag against the package version before anything is published.
// Usage: node scripts/release-check.mjs <tag>   (prints "version=<x.y.z>" for $GITHUB_OUTPUT)

import {readFileSync} from 'node:fs'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function checkRelease({tag, packageVersion, lockVersion}) {
  if (!STABLE_VERSION.test(packageVersion ?? '')) {
    throw new Error(`package.json#version must be a stable X.Y.Z version, not ${packageVersion}.`)
  }
  if (tag !== `v${packageVersion}`) {
    throw new Error(`Tag ${tag} does not match package.json#version ${packageVersion} (expected v${packageVersion}).`)
  }
  if (lockVersion !== packageVersion) {
    throw new Error(`package-lock.json version ${lockVersion} does not match package.json#version ${packageVersion}.`)
  }
  return packageVersion
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const packageJson = readJson('package.json')
    const packageLock = readJson('package-lock.json')
    const version = checkRelease({
      tag: process.argv[2],
      packageVersion: packageJson.version,
      lockVersion: packageLock.version,
    })
    console.log(`version=${version}`)
  } catch (error) {
    console.error(`release-check: ${error.message}`)
    process.exitCode = 1
  }
}
