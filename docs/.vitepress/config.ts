import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Triggerfish',
  description: 'Secure, multi-channel AI agent platform with deterministic policy enforcement below the LLM layer.',
  lang: 'en-US',
  appearance: 'force-dark',

  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/triggerfish.png' }],
    ['meta', { property: 'og:title', content: 'Triggerfish' }],
    ['meta', { property: 'og:description', content: 'Secure AI agents. Every channel. No exceptions.' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:url', content: 'https://trigger.fish' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],

  themeConfig: {
    logo: { src: '/triggerfish.png', alt: 'Triggerfish' },
    siteTitle: 'Triggerfish',

    nav: [
      { text: 'Guide', link: '/guide/' },
      { text: 'Architecture', link: '/architecture/' },
      { text: 'Security', link: '/security/' },
      { text: 'Channels', link: '/channels/' },
      { text: 'Integrations', link: '/integrations/' },
      { text: 'Features', link: '/features/' },
      { text: 'Reference', link: '/reference/' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Overview', link: '/guide/' },
            { text: 'Installation & Deployment', link: '/guide/installation' },
            { text: 'Quick Start', link: '/guide/quickstart' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'SPINE & Triggers', link: '/guide/spine-and-triggers' },
            { text: 'CLI Commands', link: '/guide/commands' },
            { text: 'Classification Guide', link: '/guide/classification-guide' },
          ],
        },
      ],
      '/architecture/': [
        {
          text: 'Architecture',
          items: [
            { text: 'Overview', link: '/architecture/' },
            { text: 'Classification System', link: '/architecture/classification' },
            { text: 'Policy Engine & Hooks', link: '/architecture/policy-engine' },
            { text: 'Sessions & Taint', link: '/architecture/taint-and-sessions' },
            { text: 'Gateway', link: '/architecture/gateway' },
            { text: 'Storage', link: '/architecture/storage' },
            { text: 'Defense in Depth', link: '/architecture/defense-in-depth' },
          ],
        },
      ],
      '/security/': [
        {
          text: 'Security Model',
          items: [
            { text: 'Security-First Design', link: '/security/' },
            { text: 'No Write-Down Rule', link: '/security/no-write-down' },
            { text: 'Identity & Auth', link: '/security/identity' },
            { text: 'Agent Delegation', link: '/security/agent-delegation' },
            { text: 'Secrets Management', link: '/security/secrets' },
            { text: 'Audit & Compliance', link: '/security/audit-logging' },
          ],
        },
        {
          text: 'Trust & Compliance',
          items: [
            { text: 'Trust Center', link: '/security/trust-center' },
            { text: 'Responsible Disclosure', link: '/security/responsible-disclosure' },
          ],
        },
      ],
      '/channels/': [
        {
          text: 'Channels',
          items: [
            { text: 'Overview', link: '/channels/' },
            { text: 'CLI', link: '/channels/cli' },
            { text: 'Telegram', link: '/channels/telegram' },
            { text: 'Slack', link: '/channels/slack' },
            { text: 'Discord', link: '/channels/discord' },
            { text: 'WhatsApp', link: '/channels/whatsapp' },
            { text: 'WebChat', link: '/channels/webchat' },
            { text: 'Email', link: '/channels/email' },
            { text: 'Signal', link: '/channels/signal' },
          ],
        },
      ],
      '/integrations/': [
        {
          text: 'Integrations',
          items: [
            { text: 'Overview', link: '/integrations/' },
            { text: 'MCP Gateway', link: '/integrations/mcp-gateway' },
            { text: 'Plugin SDK', link: '/integrations/plugins' },
            { text: 'Exec Environment', link: '/integrations/exec-environment' },
            { text: 'Skills', link: '/integrations/skills' },
            { text: 'Building Skills', link: '/integrations/building-skills' },
            { text: 'Browser Automation', link: '/integrations/browser' },
            { text: 'Webhooks', link: '/integrations/webhooks' },
            { text: 'GitHub', link: '/integrations/github' },
            { text: 'Google Workspace', link: '/integrations/google-workspace' },
            { text: 'Obsidian', link: '/integrations/obsidian' },
          ],
        },
      ],
      '/features/': [
        {
          text: 'Features',
          items: [
            { text: 'Overview', link: '/features/' },
            { text: 'Cron & Triggers', link: '/features/cron-and-triggers' },
            { text: 'Voice', link: '/features/voice' },
            { text: 'Tide Pool / A2UI', link: '/features/tidepool' },
            { text: 'Multi-Agent Routing', link: '/features/multi-agent' },
            { text: 'Model Failover', link: '/features/model-failover' },
            { text: 'Notifications', link: '/features/notifications' },
            { text: 'Logging', link: '/features/logging' },
            { text: 'Rate Limiting', link: '/features/rate-limiting' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Overview', link: '/reference/' },
            { text: 'Config Schema', link: '/reference/config-yaml' },
            { text: 'Interfaces', link: '/reference/interfaces' },
            { text: 'Glossary', link: '/reference/glossary' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/greghavens/triggerfish' },
    ],

    footer: {
      message: 'Released under the Apache 2.0 License.',
      copyright: 'Copyright 2026 Triggerfish Contributors',
    },

    search: {
      provider: 'local',
    },

    editLink: {
      pattern: 'https://github.com/greghavens/triggerfish/edit/master/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },

  markdown: {
    theme: 'github-dark',
  },
})
