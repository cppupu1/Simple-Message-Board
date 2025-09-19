const http = require('http');
const url = require('url');
const querystring = require('querystring');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const PAGE_SIZE = 50;
const MAX_MESSAGES = 1000;
const MAX_PAGES = MAX_MESSAGES / PAGE_SIZE;
const PORT = 13478;

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'messages.db');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    `);
    db.run(`
        CREATE INDEX IF NOT EXISTS idx_messages_created_at
        ON messages (created_at DESC)
    `);
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
        if (err) {
            reject(err);
            return;
        }
        resolve(this);
    });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) {
            reject(err);
            return;
        }
        resolve(row);
    });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) {
            reject(err);
            return;
        }
        resolve(rows);
    });
});

const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
        console.error('Request handling failed:', error);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        res.end('服务器内部错误');
    });
});

async function handleRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    if (req.method === 'GET' && pathname === '/') {
        await renderHome(res, parsedUrl.query);
        return;
    }

    if (req.method === 'POST' && pathname === '/submit') {
        await handleSubmit(req, res);
        return;
    }

    if (req.method === 'POST' && pathname === '/delete') {
        await handleDelete(req, res);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
}

async function renderHome(res, query) {
    const searchRaw = typeof query?.q === 'string' ? query.q.trim() : '';
    const { clause: searchClause, params: searchParams, term: searchTerm } = buildSearchClause(searchRaw);

    const totalRow = await dbGet(
        `SELECT COUNT(*) AS count FROM messages ${searchClause}`,
        searchParams
    );
    const totalMessages = totalRow?.count ? Number(totalRow.count) : 0;
    const totalPages = Math.max(1, Math.min(MAX_PAGES, Math.ceil(Math.max(totalMessages, 1) / PAGE_SIZE)));
    const requestedPage = parseInt(query?.page, 10);
    let currentPage = Number.isNaN(requestedPage) || requestedPage < 1 ? 1 : requestedPage;
    if (currentPage > totalPages) {
        currentPage = totalPages;
    }

    const offset = (currentPage - 1) * PAGE_SIZE;
    const listParams = searchParams.slice();
    listParams.push(PAGE_SIZE, offset);
    const messages = await dbAll(
        `SELECT id, content, created_at FROM messages ${searchClause} ORDER BY datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?`,
        listParams
    );

    const searchValueAttr = escapeAttribute(searchTerm);
    const searchValueHtml = escapeHtml(searchTerm);

    const listHtml = messages
        .map(({ id, content, created_at }) => {
            const safeMarkdown = escapeAttribute(content);
            const fallbackHtml = escapeHtml(content);
            const displayTime = formatDisplayTime(created_at);
            return `
                <li class="rounded-2xl border border-slate-200 bg-white/95 p-5 shadow-sm shadow-slate-100/60 transition hover:-translate-y-0.5 hover:shadow-lg dark:border-slate-800 dark:bg-slate-900/80 dark:shadow-slate-900/40">
                    <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                        <div class="flex-1 min-w-0 space-y-3">
                            <p class="text-xs font-medium text-slate-400 dark:text-slate-500">${displayTime}</p>
                            <div class="message-content prose prose-slate max-w-none text-sm dark:prose-invert" data-markdown="${safeMarkdown}">${fallbackHtml}</div>
                        </div>
                        <form action="/delete" method="post" class="flex shrink-0 items-center justify-end sm:self-start">
                            <input type="hidden" name="id" value="${id}">
                            <input type="hidden" name="page" value="${currentPage}">
                            ${searchTerm ? `<input type="hidden" name="q" value="${searchValueAttr}">` : ''}
                            <button type="submit" class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-100 hover:text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/20" data-i18n="deleteButton">删除</button>
                        </form>
                    </div>
                </li>
            `;
        })
        .join('');

    const listItems = listHtml || (searchTerm
        ? `
            <li class="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-400" data-i18n="emptySearch" data-term="${searchValueAttr}">
                没有找到包含 “${searchValueHtml}” 的留言。
            </li>
        `
        : `
            <li class="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-400" data-i18n="emptyDefault">
                还没有留言，快来留下第一条消息吧～
            </li>
        `);

    const pagination = buildPagination(currentPage, totalPages, searchTerm);

    const html = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>简易留言板</title>
            <script>
                (function() {
                    try {
                        const storedTheme = localStorage.getItem('theme');
                        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                        if (storedTheme === 'dark' || (!storedTheme && prefersDark)) {
                            document.documentElement.classList.add('dark');
                        }
                    } catch (error) {
                        // 忽略访问本地存储失败的情况
                    }
                })();
            </script>
            <script src="https://cdn.tailwindcss.com?plugins=typography"></script>
            <script>
                tailwind.config = {
                    darkMode: 'class',
                    theme: {
                        extend: {
                            fontFamily: {
                                sans: ['Inter', 'system-ui', 'sans-serif'],
                                mono: ['JetBrains Mono', 'monospace']
                            }
                        }
                    }
                };
            </script>
            <style>
                :root {
                    color-scheme: light;
                }

                .dark {
                    color-scheme: dark;
                }

                .code-block-wrapper pre,
                .code-block-wrapper pre code {
                    background: transparent !important;
                }

                .code-block-wrapper pre {
                    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
                }
            </style>
            <link rel="preconnect" href="https://fonts.bunny.net">
            <link href="https://fonts.bunny.net/css?family=inter:400,500,600|jetbrains-mono:400,500" rel="stylesheet" />
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css" referrerpolicy="no-referrer" />
        </head>
        <body class="min-h-screen bg-slate-100 font-sans text-slate-900 transition-colors duration-300 dark:bg-slate-950 dark:text-slate-100">
            <main class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8 xl:px-10">
                <div class="flex flex-col gap-6">
                <section class="rounded-3xl border border-slate-200 bg-white/85 p-6 shadow-lg shadow-slate-200/50 backdrop-blur transition-colors duration-300 dark:border-slate-800 dark:bg-slate-900/80 dark:shadow-slate-900/40">
                    <div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <h1 class="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100" data-i18n="headerTitle">简易留言板</h1>
                            <p class="text-sm text-slate-500 dark:text-slate-400" data-i18n="headerSubtitle" data-max="${MAX_MESSAGES}">支持 Markdown 留言，按 Ctrl + Enter 快速提交。最多保留 ${MAX_MESSAGES} 条。</p>
                        </div>
                        <div class="flex items-center gap-3 self-end sm:self-auto">
                            <span class="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800/80 dark:text-slate-300" data-i18n="${searchTerm ? 'statsMatches' : 'statsTotal'}" data-total="${totalMessages}">${searchTerm ? `共 ${totalMessages} 条匹配` : `共 ${totalMessages} 条留言`}</span>
                            <button type="button" id="language-toggle" class="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm shadow-slate-200 transition hover:-translate-y-0.5 hover:border-indigo-300 hover:text-indigo-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:shadow-slate-900/40 dark:hover:border-indigo-400 dark:hover:text-indigo-200">
                                <span aria-hidden="true">🌐</span>
                                <span class="language-toggle-label" data-i18n="languageZh">中文</span>
                            </button>
                            <button type="button" id="theme-toggle" class="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm shadow-slate-200 transition hover:-translate-y-0.5 hover:border-indigo-300 hover:text-indigo-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:shadow-slate-900/40 dark:hover:border-indigo-400 dark:hover:text-indigo-200">
                                <span aria-hidden="true">☀️</span>
                                <span class="theme-toggle-label">亮色</span>
                            </button>
                        </div>
                    </div>
                    <form action="/submit" method="post" class="space-y-3">
                        <div class="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-2 shadow-inner shadow-slate-200 dark:border-slate-700 dark:bg-slate-900/60 dark:shadow-slate-900/30">
                            <button type="button" class="toolbar-btn inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-200" data-action="heading-1" data-i18n="toolbarHeading1">H1</button>
                            <button type="button" class="toolbar-btn inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-200" data-action="heading-2" data-i18n="toolbarHeading2">H2</button>
                            <button type="button" class="toolbar-btn inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-200" data-action="bold" data-i18n="toolbarBold">B</button>
                            <button type="button" class="toolbar-btn inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-200" data-action="italic" data-i18n="toolbarItalic">I</button>
                            <button type="button" class="toolbar-btn inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-200" data-action="list-ul" data-i18n="toolbarListUl">• 列表</button>
                            <button type="button" class="toolbar-btn inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-200" data-action="list-ol" data-i18n="toolbarListOl">1. 列表</button>
                            <button type="button" class="toolbar-btn inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-200" data-action="code" data-i18n="toolbarInlineCode">内联代码</button>
                            <button type="button" class="toolbar-btn inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-200" data-action="code-block" data-i18n="toolbarCodeBlock">代码块</button>
                            <button type="button" class="toolbar-btn inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-200" data-action="quote" data-i18n="toolbarQuote">引用</button>
                            <button type="button" class="toolbar-btn inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-200" data-action="link" data-i18n="toolbarLink">链接</button>
                        </div>
                        <textarea id="message" name="message" rows="5" required placeholder="试试使用 **Markdown** 语法，支持代码块、列表等格式。" class="block w-full rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-sm leading-6 text-slate-800 shadow-inner shadow-slate-200 transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:shadow-slate-900/30" data-i18n-placeholder="textareaPlaceholder"></textarea>
                        <div class="flex justify-end">
                            <button type="submit" class="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm shadow-indigo-300 transition hover:-translate-y-0.5 hover:bg-indigo-500 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 dark:shadow-indigo-900/40" data-i18n="submitButton">提交留言</button>
                        </div>
                    </form>
                </section>
                        <section class="rounded-3xl border border-slate-200 bg-white/85 p-5 shadow-sm shadow-slate-200/40 transition-colors dark:border-slate-800 dark:bg-slate-900/70 dark:shadow-slate-900/40">
                    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <div class="flex flex-wrap items-center gap-2">
                            <h2 class="text-sm font-semibold text-slate-700 dark:text-slate-200" data-i18n="searchTitle">搜索留言</h2>
                            <span class="text-xs font-normal text-slate-400 dark:text-slate-500" data-i18n="searchSubtitle">支持模糊匹配并保留分页</span>
                        </div>
                        ${searchTerm ? `<span class="text-xs font-medium text-indigo-500 dark:text-indigo-300" data-i18n="searchFilter" data-term="${searchValueAttr}">已筛选：${searchValueHtml}</span>` : ''}
                    </div>
                    <form action="/" method="get" class="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-3">
                        <div class="flex flex-1 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 shadow-inner shadow-slate-200 transition focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100 dark:shadow-slate-900/30 dark:focus-within:border-indigo-400 dark:focus-within:ring-indigo-400/30">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-4 w-4 opacity-70">
                                <path stroke-linecap="round" stroke-linejoin="round" d="m21 21-4.35-4.35m0 0a7.5 7.5 0 1 0-10.607-10.607 7.5 7.5 0 0 0 10.607 10.607Z" />
                            </svg>
                            <input type="search" name="q" value="${searchValueAttr}" placeholder="输入关键字" class="flex-1 bg-transparent text-sm text-slate-600 placeholder:text-slate-400 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500" data-i18n-placeholder="searchPlaceholder">
                        </div>
                        <div class="flex items-center gap-2">
                            <button type="submit" class="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-indigo-300 transition hover:-translate-y-0.5 hover:bg-indigo-500 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 dark:shadow-indigo-900/40" data-i18n="searchButton">搜索</button>
                            ${searchTerm ? `<a href="/" class="text-xs font-medium text-slate-400 transition hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300" data-i18n="searchClear">清除</a>` : ''}
                        </div>
                    </form>
                </section>
                <section class="space-y-6 transition-colors">
                    <ul class="space-y-4">
                        ${listItems}
                    </ul>
                    ${pagination}
                </section>
                </div>
            </main>
            <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
            <script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js"></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js" referrerpolicy="no-referrer"></script>
            <script>
const LANGUAGE_KEY = 'lang';
let currentLanguage = 'zh';
const HTML_PARAM_KEYS = new Set(['term']);

const LANGUAGE_OPTIONS = {
    zh: { label: '中文', locale: 'zh-CN' },
    en: { label: 'English', locale: 'en' }
};

const translations = {
                    zh: {
                        headerTitle: '简易留言板',
                        headerSubtitle: function ({ max }) { return '支持 Markdown 留言，按 Ctrl + Enter 快速提交。最多保留 ' + max + ' 条。'; },
                        statsTotal: function ({ total }) { return '共 ' + total + ' 条留言'; },
                        statsMatches: function ({ total }) { return '共 ' + total + ' 条匹配'; },
                        submitButton: '提交留言',
                        toolbarHeading1: 'H1',
                        toolbarHeading2: 'H2',
                        toolbarBold: 'B',
                        toolbarItalic: 'I',
                        toolbarListUl: '• 列表',
                        toolbarListOl: '1. 列表',
                        toolbarInlineCode: '内联代码',
                        toolbarCodeBlock: '代码块',
                        toolbarQuote: '引用',
                        toolbarLink: '链接',
                        textareaPlaceholder: '试试使用 **Markdown** 语法，支持代码块、列表等格式。',
                        searchTitle: '搜索留言',
                        searchSubtitle: '支持模糊匹配并保留分页',
                        searchButton: '搜索',
                        searchClear: '清除',
                        searchPlaceholder: '输入关键字',
                        searchFilter: function ({ term }) { return '已筛选：' + term; },
                        languageZh: '中文',
                        languageEn: 'English',
                        themeLight: '亮色',
                        themeDark: '暗色',
                        paginationLabel: function ({ current, totalpages }) { return '第 ' + current + ' / ' + totalpages + ' 页'; },
                        paginationPrev: '上一页',
                        paginationNext: '下一页',
                        emptyDefault: '还没有留言，快来留下第一条消息吧～',
                        emptySearch: function ({ term }) { return '没有找到包含 “' + term + '” 的留言。'; },
                        copyButton: '复制',
                        copySuccess: '已复制',
                        copyFailure: '复制失败',
                        deleteButton: '删除',
                        codeFallback: '代码'
                    },
                    en: {
                        headerTitle: 'Simple Message Board',
                        headerSubtitle: function ({ max }) { return 'Supports Markdown posts. Press Ctrl + Enter to submit. Keeps up to ' + max + ' entries.'; },
                        statsTotal: function ({ total }) { return 'Total ' + total + ' messages'; },
                        statsMatches: function ({ total }) { return total + ' result' + (total == 1 ? '' : 's') + ' found'; },
                        submitButton: 'Submit Message',
                        toolbarHeading1: 'H1',
                        toolbarHeading2: 'H2',
                        toolbarBold: 'Bold',
                        toolbarItalic: 'Italic',
                        toolbarListUl: '• List',
                        toolbarListOl: '1. List',
                        toolbarInlineCode: 'Inline Code',
                        toolbarCodeBlock: 'Code Block',
                        toolbarQuote: 'Quote',
                        toolbarLink: 'Link',
                        textareaPlaceholder: 'Try **Markdown** syntax — code blocks, lists, etc.',
                        searchTitle: 'Search Messages',
                        searchSubtitle: 'Supports fuzzy matching and keeps pagination',
                        searchButton: 'Search',
                        searchClear: 'Clear',
                        searchPlaceholder: 'Enter keywords',
                        searchFilter: function ({ term }) { return 'Filter: ' + term; },
                        languageZh: 'Chinese',
                        languageEn: 'English',
                        themeLight: 'Light',
                        themeDark: 'Dark',
                        paginationLabel: function ({ current, totalpages }) { return 'Page ' + current + ' / ' + totalpages; },
                        paginationPrev: 'Previous',
                        paginationNext: 'Next',
                        emptyDefault: 'No messages yet — be the first!',
                        emptySearch: function ({ term }) { return 'No messages found containing “' + term + '”.'; },
                        copyButton: 'Copy',
                        copySuccess: 'Copied',
                        copyFailure: 'Copy failed',
                        deleteButton: 'Delete',
                        codeFallback: 'Code'
                    }
                };

                function decodeEntities(value = '') {
                    const textarea = document.createElement('textarea');
                    textarea.innerHTML = value;
                    return textarea.value;
                }

                function getParams(el) {
                    const params = {};
                    for (const [name, raw] of Object.entries(el.dataset)) {
                        if (name.startsWith('i18n')) {
                            continue;
                        }
                        let value = raw;
                        if (HTML_PARAM_KEYS.has(name)) {
                            value = decodeEntities(value);
                        }
                        const numeric = Number(value);
                        params[name] = Number.isFinite(numeric) && value !== '' ? numeric : value;
                    }
                    return params;
                }

                function t(key, vars = {}, lang = currentLanguage) {
                    const dict = translations[lang] || translations.zh;
                    const value = dict[key] ?? translations.zh[key];
                    if (typeof value === 'function') {
                        return value(vars);
                    }
                    return value !== undefined ? value : key;
                }

                function applyLanguage(mode) {
                    currentLanguage = mode;
                    const languageOption = LANGUAGE_OPTIONS[mode] || LANGUAGE_OPTIONS.zh;
                    document.documentElement.setAttribute('lang', languageOption.locale);
                    const themeMode = document.documentElement.classList.contains('dark') ? 'dark' : 'light';

                    document.querySelectorAll('[data-i18n]').forEach((element) => {
                        const key = element.dataset.i18n;
                        if (!key) {
                            return;
                        }
                        const params = getParams(element);
                        let value = t(key, params, mode);
                        if (element.dataset.uppercase === 'true' && typeof value === 'string') {
                            value = value.toUpperCase();
                        }
                        element.textContent = value;
                    });

                    document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
                        const key = element.dataset.i18nPlaceholder;
                        if (!key) {
                            return;
                        }
                        const params = getParams(element);
                        element.setAttribute('placeholder', t(key, params, mode));
                    });

                    document.title = t('headerTitle', {}, mode);
                    updateThemeToggle(themeMode);
                    updateLanguageToggle(mode);
                }

                function initializeLanguage() {
                    const toggle = document.getElementById('language-toggle');
                    let stored = null;
                    try {
                        stored = localStorage.getItem(LANGUAGE_KEY);
                    } catch (error) {
                        stored = null;
                    }
                    const initial = stored && LANGUAGE_OPTIONS[stored] ? stored : 'zh';
                    applyLanguage(initial);
                    if (stored !== initial) {
                        persistLanguage(initial);
                    }

                    toggle?.addEventListener('click', () => {
                        const next = currentLanguage === 'zh' ? 'en' : 'zh';
                        persistLanguage(next);
                        applyLanguage(next);
                    });
                }

                function updateLanguageToggle(mode) {
                    const toggle = document.getElementById('language-toggle');
                    if (!toggle) {
                        return;
                    }
                    const label = toggle.querySelector('.language-toggle-label');
                    const option = LANGUAGE_OPTIONS[mode] || LANGUAGE_OPTIONS.zh;
                    if (label) {
                        label.textContent = option.label;
                    }
                }

                function persistLanguage(value) {
                    try {
                        localStorage.setItem(LANGUAGE_KEY, value);
                    } catch (error) {
                        // ignore
                    }
                }

document.addEventListener('DOMContentLoaded', () => {
                    initializeLanguage();
                    initializeTheme();

                    if (window.marked) {
                        marked.setOptions({
                            gfm: true,
                            breaks: true,
                            smartypants: true,
                            highlight: (code, language) => {
                                if (window.hljs) {
                                    if (language && hljs.getLanguage(language)) {
                                        return hljs.highlight(code, { language }).value;
                                    }
                                    return hljs.highlightAuto(code).value;
                                }
                                return code;
                            }
                        });
                    }

                    const blocks = document.querySelectorAll('[data-markdown]');
                    blocks.forEach((element) => {
                        const markdownText = element.getAttribute('data-markdown') || '';
                        if (window.marked) {
                            const rawHtml = marked.parse(markdownText);
                            const safeHtml = window.DOMPurify ? DOMPurify.sanitize(rawHtml) : rawHtml;
                            element.innerHTML = safeHtml;
                        } else {
                            element.textContent = markdownText;
                        }
                    });

                    if (window.hljs) {
                        const codeBlocks = document.querySelectorAll('.message-content pre code');
                        codeBlocks.forEach((block) => window.hljs.highlightElement(block));
                    }

                    enhanceCodeBlocks();

                    const textarea = document.getElementById('message');
                    if (textarea) {
                        textarea.addEventListener('keydown', (event) => {
                            if (event.key === 'Enter' && event.ctrlKey) {
                                event.preventDefault();
                                textarea.form?.submit();
                            }
                        });

                        const toolbarButtons = document.querySelectorAll('.toolbar-btn');
                        toolbarButtons.forEach((button) => {
                            button.addEventListener('click', (event) => {
                                event.preventDefault();
                                const action = button.getAttribute('data-action');
                                applyMarkdown(textarea, action);
                            });
                        });
                    }
                });

                function applyMarkdown(textarea, action) {
                    if (!action) {
                        return;
                    }

                    textarea.focus();

                    let start = textarea.selectionStart;
                    let end = textarea.selectionEnd;
                    if (start === null || start === undefined || Number.isNaN(start)) {
                        start = textarea.value.length;
                    }
                    if (end === null || end === undefined || Number.isNaN(end)) {
                        end = start;
                    }

                    const value = textarea.value;
                    const selected = value.slice(start, end);
                    let replacement = selected;
                    let innerStart = 0;
                    let innerEnd = replacement.length;
                    const tick = String.fromCharCode(96);
                    const fence = tick.repeat(3);

                    const selectAll = function () {
                        innerStart = 0;
                        innerEnd = replacement.length;
                    };

                    switch (action) {
                        case "heading-1": {
                            const text = selected || "标题";
                            replacement = "# " + text;
                            innerStart = 2;
                            innerEnd = innerStart + text.length;
                            break;
                        }
                        case "heading-2": {
                            const text = selected || "小标题";
                            replacement = "## " + text;
                            innerStart = 3;
                            innerEnd = innerStart + text.length;
                            break;
                        }
                        case "bold": {
                            const text = selected || "文本";
                            replacement = "**" + text + "**";
                            innerStart = 2;
                            innerEnd = innerStart + text.length;
                            break;
                        }
                        case "italic": {
                            const text = selected || "文本";
                            replacement = "*" + text + "*";
                            innerStart = 1;
                            innerEnd = innerStart + text.length;
                            break;
                        }
                        case "list-ul": {
                            const source = selected || "列表项";
                            const lines = source.split(/\\r?\\n/);
                            replacement = lines.map((line) => "- " + (line || "列表项")).join('\\\\n');
                            selectAll();
                            break;
                        }
                        case "list-ol": {
                            const source = selected || "列表项";
                            const lines = source.split(/\\r?\\n/);
                            replacement = lines.map((line, index) => (index + 1) + ". " + (line || "列表项")).join('\\\\n');
                            selectAll();
                            break;
                        }
                        case "code": {
                            const text = selected || "代码";
                            replacement = tick + text + tick;
                            innerStart = 1;
                            innerEnd = innerStart + text.length;
                            break;
                        }
                        case "code-block": {
                            const text = selected || "代码";
                            replacement = fence + '\\\\n' + text + '\\\\n' + fence + '\\\\n';
                            innerStart = fence.length + 1;
                            innerEnd = innerStart + text.length;
                            break;
                        }
                        case "quote": {
                            const source = selected || "引用内容";
                            const lines = source.split(/\\r?\\n/);
                            replacement = lines.map((line) => "> " + (line || "引用内容")).join('\\\\n');
                            selectAll();
                            break;
                        }
                        case "link": {
                            const text = selected || "链接文本";
                            replacement = "[" + text + "](https://example.com)";
                            innerStart = 1;
                            innerEnd = innerStart + text.length;
                            break;
                        }
                        default:
                            return;
                    }

                    const before = value.slice(0, start);
                    const after = value.slice(end);
                    textarea.value = before + replacement + after;

                    const offset = before.length;
                    textarea.setSelectionRange(offset + innerStart, offset + innerEnd);
                    textarea.focus();
                    textarea.dispatchEvent(new Event('input'));
                }

                function enhanceCodeBlocks() {
                    const blocks = document.querySelectorAll('.message-content pre');
                    blocks.forEach((pre) => {
                        if (pre.dataset.enhanced === 'true') {
                            return;
                        }

                        const codeElement = pre.querySelector('code') || pre;
                        if (!codeElement) {
                            return;
                        }

                        pre.dataset.enhanced = 'true';

                        const wrapper = document.createElement('div');
                        wrapper.className = 'code-block-wrapper group overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 text-slate-800 shadow-md shadow-slate-200/60 transition-colors dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:shadow-slate-900/50';

                        const header = document.createElement('div');
                        header.className = 'flex items-center justify-between border-b border-slate-200/80 bg-slate-100/90 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500 transition-colors dark:border-white/10 dark:bg-slate-900/70 dark:text-slate-200';

                        const title = document.createElement('span');
                        const languageMatch = (codeElement.className || '').match(/language-([\w-]+)/i);
                        if (languageMatch && languageMatch[1]) {
                            title.textContent = languageMatch[1].toUpperCase();
                        } else {
                            title.dataset.i18n = 'codeFallback';
                            title.dataset.uppercase = 'true';
                            title.textContent = t('codeFallback').toUpperCase();
                        }
                        header.appendChild(title);

                        const actions = document.createElement('div');
                        actions.className = 'flex items-center gap-2';

                        const copyButton = document.createElement('button');
                        copyButton.type = 'button';
                        copyButton.className = 'inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white/40 px-2.5 py-1 text-[11px] font-medium tracking-wide text-slate-600 transition hover:border-indigo-300 hover:text-indigo-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:text-indigo-200';
                        copyButton.dataset.i18n = 'copyButton';
                        copyButton.textContent = t('copyButton');

                        copyButton.addEventListener('click', () => {
                            const originalText = codeElement.innerText;
                            const reset = () => {
                                copyButton.textContent = t('copyButton');
                            };

                            const finish = (messageKey) => {
                                copyButton.textContent = t(messageKey);
                                setTimeout(reset, 1600);
                            };

                            if (navigator.clipboard && navigator.clipboard.writeText) {
                                navigator.clipboard.writeText(originalText).then(() => {
                                    finish('copySuccess');
                                }).catch(() => {
                                    fallbackCopy(originalText, finish);
                                });
                            } else {
                                fallbackCopy(originalText, finish);
                            }
                        });

                        actions.appendChild(copyButton);
                        header.appendChild(actions);

                        const body = document.createElement('div');
                        body.className = 'relative bg-white/70 transition-colors dark:bg-slate-950/40';

                        pre.classList.add('m-0', 'max-h-[60vh]', 'overflow-auto', 'bg-transparent', 'p-4', 'text-sm', 'leading-6', 'text-slate-800', 'dark:text-slate-100');

                        const parent = pre.parentNode;
                        if (parent) {
                            wrapper.appendChild(header);
                            parent.replaceChild(wrapper, pre);
                            body.appendChild(pre);
                            wrapper.appendChild(body);
                            pre.dataset.enhanced = 'true';
                        }

                        function fallbackCopy(text, onComplete) {
                            const textarea = document.createElement('textarea');
                            textarea.value = text;
                            textarea.setAttribute('readonly', '');
                            textarea.style.position = 'absolute';
                            textarea.style.left = '-9999px';
                            document.body.appendChild(textarea);
                            textarea.select();
                            try {
                                document.execCommand('copy');
                                onComplete('copySuccess');
                            } catch (error) {
                                onComplete('copyFailure');
                            } finally {
                                document.body.removeChild(textarea);
                            }
                        }
                    });
                }

                function initializeTheme() {
                    const root = document.documentElement;
                    const themeToggle = document.getElementById('theme-toggle');
                    const media = window.matchMedia('(prefers-color-scheme: dark)');

                    let stored = null;
                    try {
                        stored = localStorage.getItem('theme');
                    } catch (error) {
                        stored = null;
                    }

                    const preferred = media.matches ? 'dark' : 'light';
                    const initial = stored === 'dark' || stored === 'light' ? stored : preferred;

                    applyTheme(initial);

                    if (!stored) {
                        persistTheme(initial);
                    }

                    themeToggle?.addEventListener('click', () => {
                        const nextTheme = root.classList.contains('dark') ? 'light' : 'dark';
                        persistTheme(nextTheme);
                        applyTheme(nextTheme);
                    });

                    media.addEventListener('change', (event) => {
                        let saved = null;
                        try {
                            saved = localStorage.getItem('theme');
                        } catch (error) {
                            saved = null;
                        }
                        if (saved === 'light' || saved === 'dark') {
                            return;
                        }
                        applyTheme(event.matches ? 'dark' : 'light');
                    });
                }

                function applyTheme(mode) {
                    const root = document.documentElement;
                    root.classList.toggle('dark', mode === 'dark');
                    updateThemeToggle(mode);
                }

                function updateThemeToggle(mode) {
                    const button = document.getElementById('theme-toggle');
                    if (!button) {
                        return;
                    }
                    const icon = button.querySelector('span[aria-hidden="true"]');
                    const label = button.querySelector('.theme-toggle-label');
                    if (icon) {
                        icon.textContent = mode === 'dark' ? '🌙' : '☀️';
                    }
                    if (label) {
                        label.textContent = mode === 'dark' ? t('themeDark') : t('themeLight');
                    }
                }

                function persistTheme(value) {
                    try {
                        localStorage.setItem('theme', value);
                    } catch (error) {
                        // ignore storage errors
                    }
                }

            </script>
        </body>
        </html>
    `;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}

async function handleSubmit(req, res) {
    const body = await readBody(req);
    const { message } = querystring.parse(body);
    const content = typeof message === 'string' ? message.trim() : '';

    if (!content) {
        redirect(res, '/');
        return;
    }

    const createdAt = new Date().toISOString();
    await dbRun('INSERT INTO messages (content, created_at) VALUES (?, ?)', [content, createdAt]);

    const totalRow = await dbGet('SELECT COUNT(*) AS count FROM messages');
    const totalMessages = totalRow?.count ? Number(totalRow.count) : 0;
    if (totalMessages > MAX_MESSAGES) {
        const overflow = totalMessages - MAX_MESSAGES;
        if (overflow > 0) {
            await dbRun(
                'DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY datetime(created_at) ASC, id ASC LIMIT ?)',
                [overflow]
            );
        }
    }

    redirect(res, '/');
}

async function handleDelete(req, res) {
    const body = await readBody(req);
    const { id, page, q } = querystring.parse(body);
    const messageId = parseInt(id, 10);
    let targetPage = parseInt(page, 10);
    const searchTerm = typeof q === 'string' ? q.trim() : '';

    if (!Number.isNaN(messageId)) {
        await dbRun('DELETE FROM messages WHERE id = ?', [messageId]);
    }

    const totalRow = await dbGet('SELECT COUNT(*) AS count FROM messages');
    const totalMessages = totalRow?.count ? Number(totalRow.count) : 0;
    const totalPages = Math.max(1, Math.min(MAX_PAGES, Math.ceil(totalMessages / PAGE_SIZE)));

    if (Number.isNaN(targetPage) || targetPage < 1) {
        targetPage = 1;
    }
    if (targetPage > totalPages) {
        targetPage = totalPages;
    }

    redirect(res, buildListPath(targetPage, searchTerm));
}

function buildListPath(page, searchTerm = '') {
    const trimmed = searchTerm ? searchTerm : '';
    if (page <= 1) {
        if (!trimmed) {
            return '/';
        }
        return `/?q=${encodeURIComponent(trimmed)}`;
    }
    const base = `/?page=${page}`;
    if (!trimmed) {
        return base;
    }
    return `${base}&q=${encodeURIComponent(trimmed)}`;
}

function buildPagination(currentPage, totalPages, searchTerm = '') {
    if (totalPages <= 1) {
        return '';
    }

    const prevPage = currentPage > 1 ? currentPage - 1 : 1;
    const nextPage = currentPage < totalPages ? currentPage + 1 : totalPages;

    const buildHref = (page) => buildListPath(page, searchTerm);

    const pageLinks = Array.from({ length: totalPages }, (_, index) => {
        const page = index + 1;
        const isActive = page === currentPage;
        const baseClasses = 'inline-flex items-center justify-center rounded-lg px-3 py-1 text-xs font-medium transition';
        const activeClasses = 'bg-indigo-600 text-white shadow-sm shadow-indigo-300 dark:shadow-indigo-900/40';
        const inactiveClasses = 'text-slate-600 hover:bg-slate-100 hover:text-indigo-600 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-indigo-300';
        return `<a href="${buildHref(page)}" class="${baseClasses} ${isActive ? activeClasses : inactiveClasses}">${page}</a>`;
    }).join('');

    const prevClasses = currentPage === 1
        ? 'inline-flex items-center justify-center rounded-lg px-3 py-1 text-xs font-medium text-slate-400 bg-slate-100/70 cursor-not-allowed dark:text-slate-600 dark:bg-slate-800/60'
        : 'inline-flex items-center justify-center rounded-lg px-3 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-slate-800';

    const nextClasses = currentPage === totalPages
        ? 'inline-flex items-center justify-center rounded-lg px-3 py-1 text-xs font-medium text-slate-400 bg-slate-100/70 cursor-not-allowed dark:text-slate-600 dark:bg-slate-800/60'
        : 'inline-flex items-center justify-center rounded-lg px-3 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-slate-800';

    return `
        <nav class="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/85 p-4 text-sm shadow-sm transition-colors sm:flex-row sm:items-center sm:justify-between dark:border-slate-800 dark:bg-slate-900/80 dark:shadow-slate-900/40">
            <div class="text-xs text-slate-500 dark:text-slate-400" data-i18n="paginationLabel" data-current="${currentPage}" data-totalpages="${totalPages}">第 ${currentPage} / ${totalPages} 页</div>
            <div class="flex flex-wrap items-center gap-2">
                <a href="${buildHref(prevPage)}" class="${prevClasses}" data-i18n="paginationPrev">上一页</a>
                <div class="flex flex-wrap items-center gap-1">
                    ${pageLinks}
                </div>
                <a href="${buildHref(nextPage)}" class="${nextClasses}" data-i18n="paginationNext">下一页</a>
            </div>
        </nav>
    `;
}

function formatDisplayTime(isoString) {
    const date = isoString ? new Date(isoString) : new Date();
    if (Number.isNaN(date.getTime())) {
        return new Date().toLocaleString('zh-CN', { hour12: false });
    }
    return date.toLocaleString('zh-CN', { hour12: false });
}

function escapeAttribute(value = '') {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\r?\n/g, '&#10;');
}

function escapeHtml(value = '') {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\r?\n/g, '<br>');
}

function buildSearchClause(input = '') {
    const term = input.trim();
    if (!term) {
        return { clause: '', params: [], term: '' };
    }
    const escaped = term.replace(/([%_\\])/g, '\\$1');
    return {
        clause: "WHERE content LIKE ? ESCAPE '\\'",
        params: [`%${escaped}%`],
        term
    };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk.toString('utf8');
            if (data.length > 1e6) {
                req.socket.destroy();
                reject(new Error('Request body too large'));
            }
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function redirect(res, location) {
    res.writeHead(302, { Location: location });
    res.end();
}

server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
    db.close(() => {
        process.exit(0);
    });
});
