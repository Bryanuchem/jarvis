/**
 * Explicit Codex MCP tool catalog. No automatic discovery of Claude MCP tools
 * or of whatever privileged servers the user may have configured elsewhere.
 */
const object = (properties = {}, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
})
const str = (description, maxLength = 1024) => ({ type: 'string', description, maxLength })
const num = (description) => ({ type: 'number', description })
const en = (values, description) => ({ type: 'string', enum: values, description })
const tab = { oneOf: [{ type: 'integer' }, { type: 'string', maxLength: 20 }], description: 'Optional numeric tab ID obtained from browser_tabs.' }

const CATALOG = [
  {
    name: 'display', description: 'Show formatted content in the JARVIS HUD. HTML is sanitized by the browser.',
    inputSchema: object({ title: str('Heading', 120), html: str('A concise fragment of HTML for the display', 24000) }, ['html']),
    category: 'display',
  },
  {
    name: 'blade', description: 'Show an image, article, video, gallery or markup blade in the JARVIS interface.',
    inputSchema: object({
      title: str('Blade title', 120),
      kind: en(['article', 'image', 'video', 'embed', 'gallery', 'markup'], 'Type of blade'),
      url: str('HTTP(S) URL for article/image/video/embed', 2048),
      html: str('HTML for markup blades', 24000),
      images: { type: 'array', items: str('HTTP(S) image URL', 2048), maxItems: 8 },
    }, ['kind']),
    category: 'display',
  },
  {
    name: 'ui_theme', description: 'Change HUD accent or background colour. Changes only this JARVIS interface.',
    inputSchema: object({ accent: str('CSS hex colour', 16), background: str('CSS hex colour', 16) }),
    category: 'display',
  },
  {
    name: 'ui_reactor', description: 'Adjust colour, scale or visibility of the reactor animation.',
    inputSchema: object({ color: str('CSS hex colour', 16), scale: num('0.2 to 3'), visible: { type: 'boolean' } }),
    category: 'display',
  },
  {
    name: 'ui_reset', description: 'Restore the JARVIS interface to defaults.',
    inputSchema: object(), category: 'display',
  },
  {
    name: 'ui_effect', description: 'Play a subtle temporary visual effect.',
    inputSchema: object({ kind: en(['glitch', 'pulse', 'scan', 'shake', 'flash'], 'Effect') }, ['kind']),
    category: 'display',
  },
  {
    name: 'browser_status', description: 'Check whether the desktop browser connector is available.',
    inputSchema: object(), category: 'browser',
  },
  {
    name: 'browser_tabs', description: 'List accessible browser tabs and their origins.',
    inputSchema: object(), category: 'browser',
  },
  {
    name: 'browser_read', description: 'Read the accessibility structure of a browser tab; only after user approval.',
    inputSchema: object({ tabId: tab, max_chars: { type: 'integer', minimum: 100, maximum: 14000 } }), category: 'browser',
  },
  {
    name: 'browser_text', description: 'Read visible text of the selected browser tab; only after user approval.',
    inputSchema: object({ tabId: tab, max_chars: { type: 'integer', minimum: 100, maximum: 14000 } }), category: 'browser',
  },
  {
    name: 'browser_screenshot', description: 'Capture screenshot of the selected browser tab; requires user approval.',
    inputSchema: object({ tabId: tab }), category: 'browser',
  },
  {
    name: 'camera_look', description: 'Capture one live camera image; requires a fresh user approval.',
    inputSchema: object({ reason: str('Describe why the image is needed', 80) }), category: 'camera',
  },
  {
    name: 'camera_watch', description: 'Capture a short camera observation; requires a fresh user approval.',
    inputSchema: object({
      reason: str('Describe why the short observation is needed', 80),
      seconds: { type: 'integer', minimum: 2, maximum: 15 },
      when: en(['now', 'past'], 'Current or recent camera frames'),
    }), category: 'camera',
  },
  {
    name: 'browser_navigate', description: 'Navigate to an absolute HTTP(S) page; requires a fresh user approval.',
    inputSchema: object({ url: str('Absolute HTTP(S) destination', 2048), tabId: tab }, ['url']), category: 'action',
  },
  {
    name: 'browser_scroll', description: 'Scroll a browser tab; requires a fresh user approval.',
    inputSchema: object({
      direction: en(['up', 'down', 'left', 'right'], 'Scroll direction'),
      amount: { type: 'integer', minimum: 1, maximum: 10 },
      tabId: tab,
    }), category: 'action',
  },
  {
    name: 'browser_click', description: 'Click a previously inspected element reference; requires a fresh user approval.',
    inputSchema: object({ ref: str('Reference from browser_read', 100), tabId: tab }, ['ref']), category: 'action',
  },
  {
    name: 'browser_type', description: 'Type text in a focused browser input; requires a fresh user approval.',
    inputSchema: object({ text: str('Text to type', 2000), tabId: tab }, ['text']), category: 'action',
  },
  {
    name: 'browser_key', description: 'Press a key or key combination; requires a fresh user approval.',
    inputSchema: object({ text: str('Key, e.g. Return', 60), tabId: tab }, ['text']), category: 'action',
  },
]

const byName = new Map(CATALOG.map((tool) => [tool.name, tool]))

export function allowedTools(flags = {}) {
  return CATALOG.filter((tool) =>
    tool.category === 'display' ||
    (tool.category === 'browser' && flags.browser) ||
    (tool.category === 'camera' && flags.camera) ||
    (tool.category === 'action' && flags.browser && flags.actions))
    .map(({ category: _category, ...tool }) => tool)
}

export function getTool(name, flags = {}) {
  const tool = byName.get(name)
  if (!tool) return null
  if (tool.category === 'browser' && !flags.browser) return null
  if (tool.category === 'camera' && !flags.camera) return null
  if (tool.category === 'action' && !(flags.browser && flags.actions)) return null
  return tool
}

/** Defense in depth. MCP clients cannot be trusted to validate input schemas. */
export function validateArgs(tool, args) {
  if (!tool) return 'Tool is not enabled.'
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Expected an object.'
  const properties = tool.inputSchema.properties
  for (const field of tool.inputSchema.required ?? []) {
    if (args[field] === undefined) return 'Missing required field: ' + field
  }
  for (const [field, value] of Object.entries(args)) {
    const rule = properties[field]
    if (!rule) return 'Unexpected field: ' + field
    const rules = rule.oneOf ?? [rule]
    if (!rules.some((r) => matches(r, value))) return 'Invalid field: ' + field
  }
  return null
}

function matches(rule, value) {
  if (rule.type === 'string') {
    return typeof value === 'string' &&
      (rule.maxLength === undefined || value.length <= rule.maxLength) &&
      (!rule.enum || rule.enum.includes(value))
  }
  if (rule.type === 'number' || rule.type === 'integer') {
    return typeof value === 'number' && Number.isFinite(value) &&
      (rule.type !== 'integer' || Number.isInteger(value)) &&
      (rule.minimum === undefined || value >= rule.minimum) &&
      (rule.maximum === undefined || value <= rule.maximum)
  }
  if (rule.type === 'boolean') return typeof value === 'boolean'
  if (rule.type === 'array') {
    return Array.isArray(value) &&
      (rule.maxItems === undefined || value.length <= rule.maxItems) &&
      value.every((item) => matches(rule.items, item))
  }
  return false
}
