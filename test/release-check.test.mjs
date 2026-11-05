import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import process from 'node:process'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {checkRelease} from '../scripts/release-check.mjs'

const scriptPath = fileURLToPath(new URL('../scripts/release-check.mjs', import.meta.url))

test('accepts a vX.Y.Z tag that matches the package and lockfile versions', () => {
  assert.equal(checkRelease({tag: 'v1.0.0', packageVersion: '1.0.0', lockVersion: '1.0.0'}), '1.0.0')
  assert.equal(checkRelease({tag: 'v10.20.3', packageVersion: '10.20.3', lockVersion: '10.20.3'}), '10.20.3')
})

test('rejects tags that do not match package.json#version', () => {
  assert.throws(
    () => checkRelease({tag: 'v1.0.1', packageVersion: '1.0.0', lockVersion: '1.0.0'}),
    /does not match package\.json#version 1\.0\.0/
  )
  assert.throws(
    () => checkRelease({tag: '1.0.0', packageVersion: '1.0.0', lockVersion: '1.0.0'}),
    /expected v1\.0\.0/
  )
  assert.throws(
    () => checkRelease({tag: undefined, packageVersion: '1.0.0', lockVersion: '1.0.0'}),
    /does not match/
  )
})

test('rejects prerelease, malformed, and lockfile-mismatched versions', () => {
  assert.throws(
    () => checkRelease({tag: 'v1.0.0-rc.1', packageVersion: '1.0.0-rc.1', lockVersion: '1.0.0-rc.1'}),
    /stable X\.Y\.Z/
  )
  assert.throws(() => checkRelease({tag: 'v01.0.0', packageVersion: '01.0.0', lockVersion: '01.0.0'}), /stable/)
  assert.throws(
    () => checkRelease({tag: 'v1.0.0', packageVersion: '1.0.0', lockVersion: '0.1.0'}),
    /package-lock\.json version 0\.1\.0/
  )
})

test('checks the repository package version from the command line', () => {
  const {version} = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const stdout = execFileSync(process.execPath, [scriptPath, `v${version}`], {encoding: 'utf8'})
  assert.equal(stdout, `version=${version}\n`)
  assert.throws(
    () => execFileSync(process.execPath, [scriptPath, 'v0.0.0-not-this'], {stdio: 'pipe'}),
    /Command failed/
  )
})
