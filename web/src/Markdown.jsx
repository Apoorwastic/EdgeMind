// Renders a model's Markdown answer (lists, **bold**, `code`, headings, code blocks, links) as React
// elements: no HTML string is ever injected, so an answer can't put markup or scripts on the page.
// Tolerant of half-written Markdown, because answers arrive token by token.

const LIST = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(\*(?![\s*])[^*\n]+?\*(?!\*)|(?<![\w])_(?![\s_])[^_\n]+?_(?![\w]))|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g

function inline(text, key = 'i') {
  const out = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const [tok] = m
    const k = `${key}-${n++}`
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>)
    else if (m[3]) out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>)
    else if (m[4]) {
      const [, label, href] = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      out.push(<a key={k} href={href} target="_blank" rel="noopener noreferrer">{label}</a>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// Consecutive list lines -> nested <ul>/<ol>, by indentation.
function list(lines, key) {
  const root = { children: [] }
  const stack = [{ indent: -1, node: root }]
  for (const line of lines) {
    const m = line.match(LIST)
    if (!m) { // a wrapped continuation line belongs to the item above
      const top = stack[stack.length - 1].node
      if (top.text !== undefined) top.text += ` ${line.trim()}`
      continue
    }
    const indent = m[1].replace(/\t/g, '  ').length
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].node
    const item = { text: m[3], ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), children: [] }
    parent.children.push(item)
    stack.push({ indent, node: item })
  }
  const render = (items, k) => {
    const groups = []
    for (const it of items) {
      const g = groups[groups.length - 1]
      if (g && g.ordered === it.ordered) g.items.push(it)
      else groups.push({ ordered: it.ordered, start: it.start, items: [it] })
    }
    return groups.map((g, gi) => {
      const Tag = g.ordered ? 'ol' : 'ul'
      return (
        <Tag key={`${k}-${gi}`} start={g.ordered && g.start > 1 ? g.start : undefined}>
          {g.items.map((it, ii) => (
            <li key={ii}>{inline(it.text, `${k}-${gi}-${ii}`)}{it.children.length > 0 && render(it.children, `${k}-${gi}-${ii}c`)}</li>
          ))}
        </Tag>
      )
    })
  }
  return render(root.children, key)
}

export default function Markdown({ text }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const k = `b${i}`
    if (!line.trim()) { i++; continue }
    if (line.trim().startsWith('```')) { // fenced code (an unclosed fence runs to the end while streaming)
      const body = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++])
      i++
      blocks.push(<pre key={k}><code>{body.join('\n')}</code></pre>)
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const Tag = `h${Math.min(h[1].length + 2, 6)}` // keep headings modest inside a chat bubble
      blocks.push(<Tag key={k}>{inline(h[2], k)}</Tag>)
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push(<hr key={k} />); i++; continue }
    if (LIST.test(line)) {
      const items = []
      while (i < lines.length && lines[i].trim() && (LIST.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) items.push(lines[i++])
      blocks.push(...list(items, k))
      continue
    }
    if (line.startsWith('>')) {
      const quote = []
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push(<blockquote key={k}>{inline(quote.join(' '), k)}</blockquote>)
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^(#{1,6}\s|```|>)/.test(lines[i])) para.push(lines[i++])
    blocks.push(
      <p key={k}>{para.flatMap((l, j) => (j ? [<br key={`${k}br${j}`} />, ...inline(l, `${k}-${j}`)] : inline(l, `${k}-${j}`)))}</p>,
    )
  }
  return <>{blocks}</>
}
