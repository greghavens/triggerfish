import { defineConfig } from "vitepress";
import fs from "node:fs";
import path from "node:path";

const recentPostsLabel: Record<string, string> = {
  "": "Recent Posts", "en-GB": "Recent Posts", "es-419": "Publicaciones recientes",
  "es-ES": "Publicaciones recientes", "fr-FR": "Articles récents",
  "zh-CN": "最新文章", "zh-TW": "最新文章", "ko-KR": "최근 게시물",
  "hi-IN": "हालिया पोस्ट", "ar-SA": "أحدث المقالات", "fil-PH": "Mga Kamakailang Post",
  "he-IL": "פוסטים אחרונים", "fa-IR": "مطالب اخیر", "pt-BR": "Publicações recentes",
  "de-DE": "Neueste Beiträge", "it-IT": "Articoli recenti",
  "ja-JP": "最近の投稿", "nb-NO": "Nylige innlegg", "nl-NL": "Recente berichten",
  "sv-SE": "Senaste inlägg", "ur-PK": "حالیہ پوسٹس", "kn-IN": "ಇತ್ತೀಚಿನ ಪೋಸ್ಟ್‌ಗಳು",
  "mr-IN": "अलीकडील पोस्ट", "ta-IN": "சமீபத்திய இடுகைகள்", "ms-MY": "Siaran Terkini",
};

const tagsLabel: Record<string, string> = {
  "": "Tags", "en-GB": "Tags", "es-419": "Etiquetas",
  "es-ES": "Etiquetas", "fr-FR": "Étiquettes",
  "zh-CN": "标签", "zh-TW": "標籤", "ko-KR": "태그",
  "hi-IN": "टैग", "ar-SA": "الوسوم", "fil-PH": "Mga Tag",
  "he-IL": "תגיות", "fa-IR": "برچسب‌ها", "pt-BR": "Tags",
  "de-DE": "Schlagwörter", "it-IT": "Tag",
  "ja-JP": "タグ", "nb-NO": "Tagger", "nl-NL": "Tags",
  "sv-SE": "Taggar", "ur-PK": "ٹیگز", "kn-IN": "ಟ್ಯಾಗ್‌ಗಳು",
  "mr-IN": "टॅग", "ta-IN": "குறிச்சொற்கள்", "ms-MY": "Tag",
};

function getBlogSidebar(locale = "") {
  const prefix = locale ? `${locale}/` : "";
  const blogDir = path.resolve(__dirname, `../${prefix}blog`);
  if (!fs.existsSync(blogDir)) return [];
  const files = fs.readdirSync(blogDir).filter(
    (f) => f.endsWith(".md") && f !== "index.md"
  );
  const posts: { title: string; link: string; date: string; tags: string[] }[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(blogDir, file), "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;
    const fm = match[1];
    const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
    const dateMatch = fm.match(/^date:\s*["']?(.+?)["']?\s*$/m);
    const draftMatch = fm.match(/^draft:\s*true/m);
    if (draftMatch) continue;
    const tagMatches = [...fm.matchAll(/^\s+-\s+(.+)$/gm)];
    const inTags = fm.indexOf("tags:") !== -1;
    const fileTags: string[] = [];
    if (inTags) {
      const tagsSection = fm.slice(fm.indexOf("tags:"));
      const tagLines = tagsSection.split("\n").slice(1);
      for (const line of tagLines) {
        const m = line.match(/^\s+-\s+(.+)$/);
        if (m) fileTags.push(m[1].trim());
        else break;
      }
    }
    posts.push({
      title: titleMatch ? titleMatch[1] : file.replace(".md", ""),
      link: `/${prefix}blog/${file.replace(".md", "")}`,
      date: dateMatch ? dateMatch[1] : "1970-01-01",
      tags: fileTags,
    });
  }
  posts.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const tagCounts = new Map<string, number>();
  for (const p of posts) {
    for (const t of p.tags) {
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
  }
  const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
  const sidebar: { text: string; items: { text: string; link: string }[] }[] = [
    {
      text: recentPostsLabel[locale] || "Recent Posts",
      items: posts.slice(0, 10).map((p) => ({ text: p.title, link: p.link })),
    },
  ];
  if (sortedTags.length > 0) {
    sidebar.push({
      text: tagsLabel[locale] || "Tags",
      items: sortedTags.map(([tag, count]) => ({
        text: `${tag} (${count})`,
        link: `/${prefix}blog/?tag=${encodeURIComponent(tag)}`,
      })),
    });
  }
  return sidebar;
}
import {
  enUS,
  enGB,
  es419,
  esES,
  frFR,
  zhCN,
  zhTW,
  koKR,
  hiIN,
  arSA,
  filPH,
  heIL,
  faIR,
  ptBR,
  deDE,
  itIT,
  jaJP,
  nbNO,
  nlNL,
  svSE,
  urPK,
  knIN,
  mrIN,
  taIN,
  msMY,
} from "./locales/mod.ts";

export default defineConfig({
  title: "Triggerfish | Multi Channel AI Agent | AI Assistant",
  description:
    "Secure, multi-channel AI agent platform with deterministic policy enforcement below the LLM layer. | AI Assistant",
  lang: "en-US",
  appearance: "force-dark",
  ignoreDeadLinks: true,

  sitemap: {
    hostname: "https://trigger.fish",
  },

  head: [
    ["link", { rel: "icon", type: "image/webp", href: "/triggerfish.webp" }],
    ["meta", { name: "google-site-verification", content: "ldCxz0D3v6Gq7KqvM3HRbUUVWAlAaoIfF81Or8r8jjg" }],

    // OpenGraph
    ["meta", {
      property: "og:title",
      content: "Triggerfish — Secure AI Agents",
    }],
    ["meta", {
      property: "og:description",
      content:
        "A secure, multi-channel AI agent platform with deterministic policy enforcement below the LLM layer. Every channel. No exceptions.",
    }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:url", content: "https://trigger.fish" }],
    ["meta", { property: "og:site_name", content: "Triggerfish" }],
    ["meta", {
      property: "og:image",
      content: "https://trigger.fish/og-image.png",
    }],
    ["meta", {
      property: "og:image:alt",
      content: "Triggerfish — secure AI agent platform",
    }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],

    // Twitter Card
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", {
      name: "twitter:title",
      content: "Triggerfish — Secure AI Agents",
    }],
    ["meta", {
      name: "twitter:description",
      content:
        "A secure, multi-channel AI agent platform with deterministic policy enforcement below the LLM layer. Every channel. No exceptions.",
    }],
    ["meta", {
      name: "twitter:image",
      content: "https://trigger.fish/og-image.png",
    }],
    ["meta", {
      name: "twitter:image:alt",
      content: "Triggerfish — secure AI agent platform",
    }],

    // Termly consent banner (must be after meta tags to avoid blocking crawlers)
    ["script", {
      src: "https://app.termly.io/resource-blocker/00bdb41e-67d7-4026-a802-0edd02329f10?autoBlock=on",
    }],
  ],

  transformHtml(code, id) {
    // Skip Cloudflare Web Analytics on /admin/ pages
    if (id.startsWith("admin/")) return;
    return code + `\n<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "57b92f80b76a4bbab40b46e7ca0019dd"}'></script>`;
  },

  locales: {
    root: {
      label: enUS.label,
      lang: enUS.lang,
      description: enUS.description,
    },
    ...Object.fromEntries(
      [
        ["en-GB", enGB], ["es-419", es419], ["es-ES", esES], ["fr-FR", frFR],
        ["zh-CN", zhCN], ["zh-TW", zhTW], ["ko-KR", koKR], ["hi-IN", hiIN],
        ["ar-SA", arSA], ["fil-PH", filPH], ["he-IL", heIL], ["fa-IR", faIR],
        ["pt-BR", ptBR], ["de-DE", deDE], ["it-IT", itIT],
        ["ja-JP", jaJP], ["nb-NO", nbNO], ["nl-NL", nlNL],
        ["sv-SE", svSE], ["ur-PK", urPK], ["kn-IN", knIN],
        ["mr-IN", mrIN], ["ta-IN", taIN], ["ms-MY", msMY],
      ].map(([key, cfg]) => [
        key,
        {
          ...(cfg as Record<string, unknown>),
          themeConfig: {
            ...((cfg as Record<string, unknown>).themeConfig as Record<string, unknown>),
            sidebar: {
              ...(((cfg as Record<string, unknown>).themeConfig as Record<string, unknown>).sidebar as Record<string, unknown>),
              [`/${key}/blog/`]: getBlogSidebar(key as string),
            },
          },
        },
      ])
    ),
  },

  themeConfig: {
    logo: { src: "/triggerfish.webp", alt: "Triggerfish" },
    siteTitle: "Triggerfish",

    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Pricing", link: "/pricing" },
      {
        text: "Docs",
        items: [
          { text: "Architecture", link: "/architecture/" },
          { text: "Security", link: "/security/" },
          { text: "Channels", link: "/channels/" },
          { text: "Integrations", link: "/integrations/" },
          { text: "Features", link: "/features/" },
          { text: "Reference", link: "/reference/" },
        ],
      },
      { text: "Use Cases", link: "/use-cases/enterprise/" },
      { text: "Support", link: "/support/" },
    ],

    sidebar: {
      "/use-cases/enterprise/": [
        {
          text: "Enterprise Use Cases",
          items: [
            { text: "Overview", link: "/use-cases/enterprise/" },
            { text: "Cross-System Orchestration", link: "/use-cases/enterprise/cross-system-orchestration" },
            { text: "Unstructured Data Ingestion", link: "/use-cases/enterprise/unstructured-data-ingestion" },
            { text: "Third-Party Portal Automation", link: "/use-cases/enterprise/portal-automation" },
            { text: "AI Inference in Production", link: "/use-cases/enterprise/ai-inference-in-production" },
          ],
        },
      ],
      "/guide/": [
        {
          text: "Getting Started",
          items: [
            { text: "Overview", link: "/guide/" },
            { text: "Installation & Deployment", link: "/guide/installation" },
            { text: "Quick Start", link: "/guide/quickstart" },
            { text: "Configuration", link: "/guide/configuration" },
            { text: "SPINE & Triggers", link: "/guide/spine-and-triggers" },
            { text: "CLI Commands", link: "/guide/commands" },
            {
              text: "Classification Guide",
              link: "/guide/classification-guide",
            },
          ],
        },
      ],
      "/architecture/": [
        {
          text: "Architecture",
          items: [
            { text: "Overview", link: "/architecture/" },
            {
              text: "Classification System",
              link: "/architecture/classification",
            },
            {
              text: "Policy Engine & Hooks",
              link: "/architecture/policy-engine",
            },
            {
              text: "Sessions & Taint",
              link: "/architecture/taint-and-sessions",
            },
            { text: "Gateway", link: "/architecture/gateway" },
            { text: "Storage", link: "/architecture/storage" },
            {
              text: "Defense in Depth",
              link: "/architecture/defense-in-depth",
            },
          ],
        },
      ],
      "/security/": [
        {
          text: "Security Model",
          items: [
            { text: "Security-First Design", link: "/security/" },
            { text: "No Write-Down Rule", link: "/security/no-write-down" },
            { text: "Identity & Auth", link: "/security/identity" },
            { text: "Agent Delegation", link: "/security/agent-delegation" },
            { text: "Secrets Management", link: "/security/secrets" },
            { text: "Audit & Compliance", link: "/security/audit-logging" },
          ],
        },
        {
          text: "Trust & Compliance",
          items: [
            { text: "Trust Center", link: "/security/trust-center" },
            {
              text: "Responsible Disclosure",
              link: "/security/responsible-disclosure",
            },
          ],
        },
      ],
      "/channels/": [
        {
          text: "Channels",
          items: [
            { text: "Overview", link: "/channels/" },
            { text: "CLI", link: "/channels/cli" },
            { text: "Telegram", link: "/channels/telegram" },
            { text: "Slack", link: "/channels/slack" },
            { text: "Discord", link: "/channels/discord" },
            { text: "WhatsApp", link: "/channels/whatsapp" },
            { text: "WebChat", link: "/channels/webchat" },
            { text: "Email", link: "/channels/email" },
            { text: "Signal", link: "/channels/signal" },
            { text: "Google Chat", link: "/channels/google-chat" },
          ],
        },
      ],
      "/integrations/": [
        {
          text: "Integrations",
          items: [
            { text: "Overview", link: "/integrations/" },
            { text: "MCP Gateway", link: "/integrations/mcp-gateway" },
            { text: "Plugin SDK", link: "/integrations/plugins" },
            {
              text: "Exec Environment",
              link: "/integrations/exec-environment",
            },
            { text: "Skills", link: "/integrations/skills" },
            { text: "Building Skills", link: "/integrations/building-skills" },
            { text: "Browser Automation", link: "/integrations/browser" },
            { text: "Webhooks", link: "/integrations/webhooks" },
            { text: "GitHub", link: "/integrations/github" },
            {
              text: "Google Workspace",
              link: "/integrations/google-workspace",
            },
            { text: "Obsidian", link: "/integrations/obsidian" },
            { text: "CalDAV", link: "/integrations/caldav" },
            { text: "Remote Access", link: "/integrations/remote" },
          ],
        },
      ],
      "/features/": [
        {
          text: "Features",
          items: [
            { text: "Overview", link: "/features/" },
            { text: "Cron & Triggers", link: "/features/cron-and-triggers" },
            { text: "Voice", link: "/features/voice" },
            { text: "Tide Pool / A2UI", link: "/features/tidepool" },
            { text: "Multi-Agent Routing", link: "/features/multi-agent" },
            { text: "Model Failover", link: "/features/model-failover" },
            { text: "Notifications", link: "/features/notifications" },
            { text: "Logging", link: "/features/logging" },
            { text: "Agent Teams", link: "/features/agent-teams" },
            { text: "Workflows", link: "/features/workflows" },
            { text: "Rate Limiting", link: "/features/rate-limiting" },
            { text: "Explore", link: "/features/explore" },
            { text: "Filesystem", link: "/features/filesystem" },
            { text: "Image & Vision", link: "/features/image-vision" },
            { text: "Memory", link: "/features/memory" },
            { text: "Planning", link: "/features/planning" },
            { text: "Sessions", link: "/features/sessions" },
            { text: "Web Search", link: "/features/web-search" },
            { text: "Subagents", link: "/features/subagents" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Overview", link: "/reference/" },
            { text: "Config Schema", link: "/reference/config-yaml" },
            { text: "Workflow DSL", link: "/reference/workflow-dsl" },
            { text: "Interfaces", link: "/reference/interfaces" },
            { text: "Glossary", link: "/reference/glossary" },
          ],
        },
      ],
      "/support/": [
        {
          text: "Support Center",
          items: [
            { text: "Overview", link: "/support/" },
            { text: "FAQ", link: "/support/faq" },
          ],
        },
        {
          text: "Troubleshooting",
          items: [
            { text: "Start Here", link: "/support/troubleshooting/" },
            {
              text: "Installation",
              link: "/support/troubleshooting/installation",
            },
            { text: "Daemon", link: "/support/troubleshooting/daemon" },
            {
              text: "Configuration",
              link: "/support/troubleshooting/configuration",
            },
            { text: "Channels", link: "/support/troubleshooting/channels" },
            {
              text: "LLM Providers",
              link: "/support/troubleshooting/providers",
            },
            {
              text: "Integrations",
              link: "/support/troubleshooting/integrations",
            },
            {
              text: "Browser Automation",
              link: "/support/troubleshooting/browser",
            },
            {
              text: "Security & Classification",
              link: "/support/troubleshooting/security",
            },
            {
              text: "Secrets & Credentials",
              link: "/support/troubleshooting/secrets",
            },
            {
              text: "Workflows",
              link: "/support/troubleshooting/workflows",
            },
            {
              text: "Error Reference",
              link: "/support/troubleshooting/error-reference",
            },
          ],
        },
        {
          text: "How-To Guides",
          items: [
            {
              text: "Collecting Logs",
              link: "/support/guides/collecting-logs",
            },
            {
              text: "Running Diagnostics",
              link: "/support/guides/diagnostics",
            },
            { text: "Filing Issues", link: "/support/guides/filing-issues" },
            {
              text: "Platform Notes",
              link: "/support/guides/platform-notes",
            },
          ],
        },
        {
          text: "Knowledge Base",
          items: [
            {
              text: "Secrets Migration",
              link: "/support/kb/secrets-migration",
            },
            { text: "Self-Update Process", link: "/support/kb/self-update" },
            {
              text: "Breaking Changes",
              link: "/support/kb/breaking-changes",
            },
            { text: "Known Issues", link: "/support/kb/known-issues" },
          ],
        },
      ],
      "/blog/": getBlogSidebar(),
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/greghavens/triggerfish" },
    ],

    footer: {
      message:
        'Released under the Apache 2.0 License. | <a href="/blog/">Blog</a> | <a href="/account">Account</a> | <a href="/privacy-policy">Privacy Policy</a> | <a href="/cookie-policy">Cookie Policy</a> | <a href="/terms-of-service">Terms of Service</a>',
      copyright: "Copyright 2026 Triggerfish, Inc.",
    },

    search: {
      provider: "local",
      options: {
        locales: {
          root: {
            translations: {
              button: {
                buttonText: "Search",
                buttonAriaLabel: "Search",
              },
              modal: {
                displayDetails: "Display detailed list",
                resetButtonTitle: "Reset search",
                backButtonTitle: "Close search",
                noResultsText: "No results for",
                footer: {
                  selectText: "to select",
                  navigateText: "to navigate",
                  closeText: "to close",
                },
              },
            },
          },
          "en-GB": {
            translations: {
              button: {
                buttonText: "Search",
                buttonAriaLabel: "Search",
              },
              modal: {
                displayDetails: "Display detailed list",
                resetButtonTitle: "Reset search",
                backButtonTitle: "Close search",
                noResultsText: "No results for",
                footer: {
                  selectText: "to select",
                  navigateText: "to navigate",
                  closeText: "to close",
                },
              },
            },
          },
          "es-419": {
            translations: {
              button: {
                buttonText: "Buscar",
                buttonAriaLabel: "Buscar",
              },
              modal: {
                displayDetails: "Mostrar lista detallada",
                resetButtonTitle: "Restablecer búsqueda",
                backButtonTitle: "Cerrar búsqueda",
                noResultsText: "Sin resultados para",
                footer: {
                  selectText: "para seleccionar",
                  navigateText: "para navegar",
                  closeText: "para cerrar",
                },
              },
            },
          },
          "es-ES": {
            translations: {
              button: {
                buttonText: "Buscar",
                buttonAriaLabel: "Buscar",
              },
              modal: {
                displayDetails: "Mostrar lista detallada",
                resetButtonTitle: "Restablecer búsqueda",
                backButtonTitle: "Cerrar búsqueda",
                noResultsText: "Sin resultados para",
                footer: {
                  selectText: "para seleccionar",
                  navigateText: "para navegar",
                  closeText: "para cerrar",
                },
              },
            },
          },
          "fr-FR": {
            translations: {
              button: {
                buttonText: "Rechercher",
                buttonAriaLabel: "Rechercher",
              },
              modal: {
                displayDetails: "Afficher la liste détaillée",
                resetButtonTitle: "Réinitialiser la recherche",
                backButtonTitle: "Fermer la recherche",
                noResultsText: "Aucun résultat pour",
                footer: {
                  selectText: "pour sélectionner",
                  navigateText: "pour naviguer",
                  closeText: "pour fermer",
                },
              },
            },
          },
          "zh-CN": {
            translations: {
              button: {
                buttonText: "搜索",
                buttonAriaLabel: "搜索",
              },
              modal: {
                displayDetails: "显示详细列表",
                resetButtonTitle: "重置搜索",
                backButtonTitle: "关闭搜索",
                noResultsText: "未找到相关结果",
                footer: {
                  selectText: "选择",
                  navigateText: "导航",
                  closeText: "关闭",
                },
              },
            },
          },
          "zh-TW": {
            translations: {
              button: {
                buttonText: "搜尋",
                buttonAriaLabel: "搜尋",
              },
              modal: {
                displayDetails: "顯示詳細列表",
                resetButtonTitle: "重設搜尋",
                backButtonTitle: "關閉搜尋",
                noResultsText: "未找到相關結果",
                footer: {
                  selectText: "選擇",
                  navigateText: "導覽",
                  closeText: "關閉",
                },
              },
            },
          },
          "ko-KR": {
            translations: {
              button: {
                buttonText: "검색",
                buttonAriaLabel: "검색",
              },
              modal: {
                displayDetails: "상세 목록 표시",
                resetButtonTitle: "검색 초기화",
                backButtonTitle: "검색 닫기",
                noResultsText: "검색 결과 없음",
                footer: {
                  selectText: "선택",
                  navigateText: "탐색",
                  closeText: "닫기",
                },
              },
            },
          },
          "hi-IN": {
            translations: {
              button: {
                buttonText: "खोजें",
                buttonAriaLabel: "खोजें",
              },
              modal: {
                displayDetails: "विस्तृत सूची दिखाएँ",
                resetButtonTitle: "खोज रीसेट करें",
                backButtonTitle: "खोज बंद करें",
                noResultsText: "कोई परिणाम नहीं",
                footer: {
                  selectText: "चुनने के लिए",
                  navigateText: "नेविगेट करने के लिए",
                  closeText: "बंद करने के लिए",
                },
              },
            },
          },
          "ar-SA": {
            translations: {
              button: {
                buttonText: "بحث",
                buttonAriaLabel: "بحث",
              },
              modal: {
                displayDetails: "عرض القائمة التفصيلية",
                resetButtonTitle: "إعادة تعيين البحث",
                backButtonTitle: "إغلاق البحث",
                noResultsText: "لا توجد نتائج لـ",
                footer: {
                  selectText: "للاختيار",
                  navigateText: "للتنقل",
                  closeText: "للإغلاق",
                },
              },
            },
          },
          "fil-PH": {
            translations: {
              button: {
                buttonText: "Maghanap",
                buttonAriaLabel: "Maghanap",
              },
              modal: {
                displayDetails: "Ipakita ang detalyadong listahan",
                resetButtonTitle: "I-reset ang paghahanap",
                backButtonTitle: "Isara ang paghahanap",
                noResultsText: "Walang resulta para sa",
                footer: {
                  selectText: "para pumili",
                  navigateText: "para mag-navigate",
                  closeText: "para isara",
                },
              },
            },
          },
          "he-IL": {
            translations: {
              button: {
                buttonText: "חיפוש",
                buttonAriaLabel: "חיפוש",
              },
              modal: {
                displayDetails: "הצג רשימה מפורטת",
                resetButtonTitle: "אפס חיפוש",
                backButtonTitle: "סגור חיפוש",
                noResultsText: "אין תוצאות עבור",
                footer: {
                  selectText: "לבחירה",
                  navigateText: "לניווט",
                  closeText: "לסגירה",
                },
              },
            },
          },
          "fa-IR": {
            translations: {
              button: {
                buttonText: "جستجو",
                buttonAriaLabel: "جستجو",
              },
              modal: {
                displayDetails: "نمایش لیست جزئیات",
                resetButtonTitle: "بازنشانی جستجو",
                backButtonTitle: "بستن جستجو",
                noResultsText: "نتیجه‌ای برای",
                footer: {
                  selectText: "برای انتخاب",
                  navigateText: "برای ناوبری",
                  closeText: "برای بستن",
                },
              },
            },
          },
          "pt-BR": {
            translations: {
              button: {
                buttonText: "Pesquisar",
                buttonAriaLabel: "Pesquisar",
              },
              modal: {
                displayDetails: "Exibir lista detalhada",
                resetButtonTitle: "Redefinir pesquisa",
                backButtonTitle: "Fechar pesquisa",
                noResultsText: "Sem resultados para",
                footer: {
                  selectText: "para selecionar",
                  navigateText: "para navegar",
                  closeText: "para fechar",
                },
              },
            },
          },
          "de-DE": {
            translations: {
              button: {
                buttonText: "Suchen",
                buttonAriaLabel: "Suchen",
              },
              modal: {
                displayDetails: "Detaillierte Liste anzeigen",
                resetButtonTitle: "Suche zurücksetzen",
                backButtonTitle: "Suche schließen",
                noResultsText: "Keine Ergebnisse für",
                footer: {
                  selectText: "zum Auswählen",
                  navigateText: "zum Navigieren",
                  closeText: "zum Schließen",
                },
              },
            },
          },
          "it-IT": {
            translations: {
              button: {
                buttonText: "Cerca",
                buttonAriaLabel: "Cerca",
              },
              modal: {
                displayDetails: "Mostra elenco dettagliato",
                resetButtonTitle: "Reimposta ricerca",
                backButtonTitle: "Chiudi ricerca",
                noResultsText: "Nessun risultato per",
                footer: {
                  selectText: "per selezionare",
                  navigateText: "per navigare",
                  closeText: "per chiudere",
                },
              },
            },
          },
          "ja-JP": {
            translations: {
              button: {
                buttonText: "検索",
                buttonAriaLabel: "検索",
              },
              modal: {
                displayDetails: "詳細リストを表示",
                resetButtonTitle: "検索をリセット",
                backButtonTitle: "検索を閉じる",
                noResultsText: "結果なし",
                footer: {
                  selectText: "選択",
                  navigateText: "ナビゲート",
                  closeText: "閉じる",
                },
              },
            },
          },
          "nb-NO": {
            translations: {
              button: {
                buttonText: "Søk",
                buttonAriaLabel: "Søk",
              },
              modal: {
                displayDetails: "Vis detaljert liste",
                resetButtonTitle: "Tilbakestill søk",
                backButtonTitle: "Lukk søk",
                noResultsText: "Ingen resultater for",
                footer: {
                  selectText: "for å velge",
                  navigateText: "for å navigere",
                  closeText: "for å lukke",
                },
              },
            },
          },
          "nl-NL": {
            translations: {
              button: {
                buttonText: "Zoeken",
                buttonAriaLabel: "Zoeken",
              },
              modal: {
                displayDetails: "Gedetailleerde lijst weergeven",
                resetButtonTitle: "Zoekopdracht resetten",
                backButtonTitle: "Zoekopdracht sluiten",
                noResultsText: "Geen resultaten voor",
                footer: {
                  selectText: "om te selecteren",
                  navigateText: "om te navigeren",
                  closeText: "om te sluiten",
                },
              },
            },
          },
          "sv-SE": {
            translations: {
              button: {
                buttonText: "Sök",
                buttonAriaLabel: "Sök",
              },
              modal: {
                displayDetails: "Visa detaljerad lista",
                resetButtonTitle: "Återställ sökning",
                backButtonTitle: "Stäng sökning",
                noResultsText: "Inga resultat för",
                footer: {
                  selectText: "för att välja",
                  navigateText: "för att navigera",
                  closeText: "för att stänga",
                },
              },
            },
          },
          "ur-PK": {
            translations: {
              button: {
                buttonText: "تلاش",
                buttonAriaLabel: "تلاش",
              },
              modal: {
                displayDetails: "تفصیلی فہرست دکھائیں",
                resetButtonTitle: "تلاش ری سیٹ کریں",
                backButtonTitle: "تلاش بند کریں",
                noResultsText: "کوئی نتائج نہیں",
                footer: {
                  selectText: "منتخب کرنے کے لیے",
                  navigateText: "نیویگیٹ کرنے کے لیے",
                  closeText: "بند کرنے کے لیے",
                },
              },
            },
          },
          "kn-IN": {
            translations: {
              button: {
                buttonText: "ಹುಡುಕಿ",
                buttonAriaLabel: "ಹುಡುಕಿ",
              },
              modal: {
                displayDetails: "ವಿವರವಾದ ಪಟ್ಟಿ ತೋರಿಸಿ",
                resetButtonTitle: "ಹುಡುಕಾಟ ಮರುಹೊಂದಿಸಿ",
                backButtonTitle: "ಹುಡುಕಾಟ ಮುಚ್ಚಿ",
                noResultsText: "ಯಾವುದೇ ಫಲಿತಾಂಶವಿಲ್ಲ",
                footer: {
                  selectText: "ಆಯ್ಕೆ ಮಾಡಲು",
                  navigateText: "ನ್ಯಾವಿಗೇಟ್ ಮಾಡಲು",
                  closeText: "ಮುಚ್ಚಲು",
                },
              },
            },
          },
          "mr-IN": {
            translations: {
              button: {
                buttonText: "शोधा",
                buttonAriaLabel: "शोधा",
              },
              modal: {
                displayDetails: "तपशीलवार यादी दाखवा",
                resetButtonTitle: "शोध रीसेट करा",
                backButtonTitle: "शोध बंद करा",
                noResultsText: "कोणतेही परिणाम नाहीत",
                footer: {
                  selectText: "निवडण्यासाठी",
                  navigateText: "नेव्हिगेट करण्यासाठी",
                  closeText: "बंद करण्यासाठी",
                },
              },
            },
          },
          "ta-IN": {
            translations: {
              button: {
                buttonText: "தேடு",
                buttonAriaLabel: "தேடு",
              },
              modal: {
                displayDetails: "விரிவான பட்டியலைக் காட்டு",
                resetButtonTitle: "தேடலை மீட்டமை",
                backButtonTitle: "தேடலை மூடு",
                noResultsText: "முடிவுகள் இல்லை",
                footer: {
                  selectText: "தேர்ந்தெடுக்க",
                  navigateText: "வழிசெலுத்த",
                  closeText: "மூட",
                },
              },
            },
          },
          "ms-MY": {
            translations: {
              button: {
                buttonText: "Cari",
                buttonAriaLabel: "Cari",
              },
              modal: {
                displayDetails: "Papar senarai terperinci",
                resetButtonTitle: "Set semula carian",
                backButtonTitle: "Tutup carian",
                noResultsText: "Tiada keputusan untuk",
                footer: {
                  selectText: "untuk memilih",
                  navigateText: "untuk menavigasi",
                  closeText: "untuk menutup",
                },
              },
            },
          },
        },
      },
    },

    editLink: {
      pattern:
        "https://github.com/greghavens/triggerfish/edit/master/docs/:path",
      text: "Edit this page on GitHub",
    },
  },

  markdown: {
    theme: "github-dark",
  },
});
