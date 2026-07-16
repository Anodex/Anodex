import { describe, expect, it, vi } from 'vitest'
import { buildGithubServerConfig, parseGithubAccount } from '../GitHubService'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/anodex-test', getVersion: () => '0.0.0-test' },
  safeStorage: { isEncryptionAvailable: () => false }
}))

describe('buildGithubServerConfig', () => {
  it('builds the official hosted read-only preset with selected toolsets', () => {
    const config = buildGithubServerConfig({
      readOnly: true,
      toolsets: ['repos', 'pull_requests']
    })
    expect(config.url).toBe('https://api.githubcopilot.com/mcp/')
    expect(config.preset).toBe('github')
    expect(config.headers).toEqual({
      'X-MCP-Toolsets': 'context,repos,pull_requests',
      'X-MCP-Readonly': 'true'
    })
  })
})

describe('parseGithubAccount', () => {
  it('reads account details from structured content', () => {
    expect(
      parseGithubAccount({
        structuredContent: {
          login: 'octocat',
          name: 'The Octocat',
          avatar_url: 'https://avatars.example/octocat',
          html_url: 'https://github.com/octocat'
        }
      })
    ).toEqual({
      login: 'octocat',
      name: 'The Octocat',
      avatarUrl: 'https://avatars.example/octocat',
      profileUrl: 'https://github.com/octocat'
    })
  })

  it('reads nested JSON returned in a text block', () => {
    expect(
      parseGithubAccount({
        content: [{ type: 'text', text: '{"user":{"login":"octocat"}}' }]
      })
    ).toEqual({ login: 'octocat', name: undefined, avatarUrl: undefined, profileUrl: undefined })
  })
})
