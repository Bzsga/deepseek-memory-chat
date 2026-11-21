import { fromMarkdown } from 'mdast-util-from-markdown'

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (text) => text.replace(/[&<>"']/g, (character) => entities[character])
const renderChildren = (node, separator = '') => node.children.map(renderNode).join(separator)

function renderNode(node) {
  switch (node.type) {
    case 'root':
      return renderChildren(node, '\n')
    case 'heading':
      return `<h${node.depth}>${renderChildren(node)}</h${node.depth}>`
    case 'paragraph':
      return `<p>${renderChildren(node)}</p>`
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul'
      const start = node.ordered && node.start !== 1 ? ` start="${node.start}"` : ''
      return `<${tag}${start}>${renderChildren(node, '\n')}</${tag}>`
    }
    case 'listItem':
      return `<li>${renderChildren(node)}</li>`
    case 'strong':
      return `<strong>${renderChildren(node)}</strong>`
    case 'emphasis':
      return `<em>${renderChildren(node)}</em>`
    case 'inlineCode':
      return `<code>${escapeHtml(node.value)}</code>`
    case 'link': {
      const label = renderChildren(node)
      const protocol = URL.canParse(node.url, 'https://example.invalid/')
        ? new URL(node.url, 'https://example.invalid/').protocol
        : null
      return protocol === 'https:' || protocol === 'http:'
        ? `<a href="${escapeHtml(node.url)}">${label}</a>`
        : label
    }
    case 'break':
      return '<br>'
    default:
      if (node.children) return renderChildren(node)
      return escapeHtml(node.value ?? '')
  }
}

export function renderChangelog(markdown) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>更新记录 · DeepSeek 记忆聊天</title>
  <style>
    :root {
      color-scheme: light dark;
      --background: #f5f7fc;
      --panel: #fff;
      --text: #1b2335;
      --muted: #515d71;
      --line: #dce3ee;
      --link: #284cb7;
      font-family: system-ui, sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --background: #111621;
        --panel: #1a2130;
        --text: #edf1f8;
        --muted: #b8c5d9;
        --line: #39455b;
        --link: #aabaff;
      }
    }
    body { margin: 0; background: var(--background); color: var(--text); line-height: 1.65; }
    main { max-width: 46rem; margin: auto; padding: clamp(1rem, 4vw, 2.5rem); }
    article {
      padding: clamp(1rem, 4vw, 2rem);
      border: 1px solid var(--line);
      border-radius: 1rem;
      background: var(--panel);
      overflow-wrap: anywhere;
    }
    a { color: var(--link); text-underline-offset: .18em; }
    a:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; }
    .back { display: inline-block; margin-bottom: 1rem; }
    h1 { margin: 0 0 .75rem; font-size: clamp(1.65rem, 5vw, 2.3rem); line-height: 1.2; }
    h2 {
      margin: 1.5rem 0 .6rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--line);
      font-size: 1.15rem;
      line-height: 1.4;
    }
    p, li { margin: 0 0 .5rem; }
    article > p { color: var(--muted); }
    ul, ol { margin: 0; padding-inline-start: 1.3rem; }
    li > p:last-child, li:last-child { margin-bottom: 0; }
  </style>
</head>
<body>
  <main>
    <a class="back" href="./">返回聊天</a>
    <article>
${renderNode(fromMarkdown(markdown))}
    </article>
  </main>
</body>
</html>
`
}
