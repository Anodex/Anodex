import { describe, expect, it } from 'vitest'
import {
  detectFallbackToolCall,
  findPotentialToolCallTextStart,
  stripFallbackCall
} from '../toolCallFallback'

const TOOLS = new Set(['read_file', 'write_file', 'list_directory'])

describe('detectFallbackToolCall', () => {
  it('detects a call wrapped in <tool_call> tags', () => {
    const text =
      '<tool_call>\n{"name": "read_file", "arguments": {"path": "math.js"}}\n</tool_call>'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call).toEqual({
      name: 'read_file',
      arguments: { path: 'math.js' },
      matchedText: text
    })
  })

  it('detects a call inside a ```json fence', () => {
    const text =
      'I\'ll start by reading the file.\n\n```json\n{"name": "read_file", "arguments": {"path": "math.js"}}\n```'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call?.name).toBe('read_file')
    expect(call?.arguments).toEqual({ path: 'math.js' })
  })

  it('detects a call inside a bare fence with no language tag', () => {
    const text = '```\n{"name": "list_directory", "arguments": {}}\n```'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call?.name).toBe('list_directory')
  })

  it('detects a bare JSON object that is the entire response', () => {
    const text = '{"name": "write_file", "arguments": {"path": "a.txt", "content": "hi"}}'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call?.name).toBe('write_file')
  })

  it('does not match a JSON example embedded mid-line in a longer explanation', () => {
    const text =
      'You would call it like this: {"name": "read_file", "arguments": {"path": "x"}} to read a file, then continue.'
    expect(detectFallbackToolCall(text, TOOLS)).toBeNull()
  })

  it('detects a call that sits alone on its own line within a longer explanation', () => {
    const text =
      "Let's start by identifying the missing function. I'll first list the directory.\n\n" +
      '{"name": "list_directory", "arguments": {"path": "."}}'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call?.name).toBe('list_directory')
  })

  it('detects a trailing embedded JSON call after prose', () => {
    const text =
      'Let me patch that now. {"name": "write_file", "arguments": {"path": "a.txt", "content": "hi"}}'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call?.name).toBe('write_file')
    expect(call?.arguments).toEqual({ path: 'a.txt', content: 'hi' })
    expect(stripFallbackCall(text, call!)).toBe('Let me patch that now.')
  })

  it('ignores a call to a tool name that is not registered', () => {
    const text = '<tool_call>{"name": "delete_everything", "arguments": {}}</tool_call>'
    expect(detectFallbackToolCall(text, TOOLS)).toBeNull()
  })

  it('ignores malformed JSON', () => {
    const text = '<tool_call>{"name": "read_file", "arguments": }</tool_call>'
    expect(detectFallbackToolCall(text, TOOLS)).toBeNull()
  })

  it('recovers a call with an invalid backslash-escaped single quote', () => {
    const text =
      '```json\n{\n  "name": "write_file",\n  "arguments": {\n    "path": "stringUtils.js",\n' +
      '    "content": "const shout = (str) => str.toUpperCase() + \'!\\\';\\n"\n  }\n}\n```'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call?.name).toBe('write_file')
    expect(call?.arguments.content).toBe("const shout = (str) => str.toUpperCase() + '!';\n")
  })

  it('returns null for ordinary text with no tool call', () => {
    expect(detectFallbackToolCall('The bug is in the add function.', TOOLS)).toBeNull()
  })

  it('defaults arguments to an empty object when omitted', () => {
    const text = '<tool_call>{"name": "list_directory"}</tool_call>'
    const call = detectFallbackToolCall(text, TOOLS)
    expect(call?.arguments).toEqual({})
  })

  it('detects a self-closing XML-style pseudo-tag with attributes as arguments', () => {
    // Regression test: observed live with gemma4-coding-Q8_0 — nudged to
    // "call preview_html", it wrote `<preview_html path="..." title="..." />`
    // literally in its reply instead of using real function-calling, and the
    // tag leaked into the chat transcript as dead text.
    const tools = new Set(['preview_html'])
    const text =
      "I'll add keyboard navigation support.\n\n" +
      '<preview_html path="index.html" title="Personal Portfolio Site" />'
    const call = detectFallbackToolCall(text, tools)
    expect(call?.name).toBe('preview_html')
    expect(call?.arguments).toEqual({ path: 'index.html', title: 'Personal Portfolio Site' })
    expect(stripFallbackCall(text, call!)).toBe("I'll add keyboard navigation support.")
  })

  it('ignores a self-closing tag with no attributes', () => {
    expect(detectFallbackToolCall('Some text with a <br/> line break.', TOOLS)).toBeNull()
  })

  it('ignores a self-closing tag whose name is not a registered tool', () => {
    const text = '<foo_bar path="x" />'
    expect(detectFallbackToolCall(text, TOOLS)).toBeNull()
  })
})

describe('findPotentialToolCallTextStart', () => {
  it('returns the beginning of trailing raw JSON so streaming can hold it', () => {
    const text = 'I will update the CSS now. {"name": "write_file"'
    expect(findPotentialToolCallTextStart(text)).toBe('I will update the CSS now. '.length)
  })

  it('returns -1 for ordinary prose', () => {
    expect(findPotentialToolCallTextStart('I will update the CSS now.')).toBe(-1)
  })
})

describe('stripFallbackCall', () => {
  it('removes the matched text and trims the remainder', () => {
    const text =
      'Let me check that file.\n\n<tool_call>{"name": "read_file", "arguments": {}}</tool_call>'
    const call = detectFallbackToolCall(text, TOOLS)!
    expect(stripFallbackCall(text, call)).toBe('Let me check that file.')
  })

  it('returns an empty string when the call was the entire response', () => {
    const text = '{"name": "read_file", "arguments": {}}'
    const call = detectFallbackToolCall(text, TOOLS)!
    expect(stripFallbackCall(text, call)).toBe('')
  })
})

// Qwen-style pseudo-XML. Observed ending a live turn: the model wrote this
// instead of calling the tool, nothing parsed it, the round produced no tool
// call, and the provider loop read that as "finished" mid-fix.
describe('detectFallbackToolCall with <function=…> pseudo-XML', () => {
  const SEARCH_TOOLS = new Set(['search_files', 'read_file'])

  it('parses a <tool_call>-wrapped function block that was never closed', () => {
    const text =
      'Now I need to check the other references. Let me search for that.\n\n' +
      '<tool_call>\n<function=search_files>\n<parameter=path>\njs\n</parameter>\n' +
      '<parameter=query>\nnew OrbitControls\n</parameter>\n'

    const call = detectFallbackToolCall(text, SEARCH_TOOLS)
    expect(call?.name).toBe('search_files')
    expect(call?.arguments).toEqual({ path: 'js', query: 'new OrbitControls' })
    expect(call?.matchedText).toContain('<function=search_files>')
    expect(stripFallbackCall(text, call!)).toBe(
      'Now I need to check the other references. Let me search for that.'
    )
  })

  it('parses a fully closed function block and strips both wrappers', () => {
    const text =
      'Checking.\n<tool_call><function=read_file><parameter=path>a.ts</parameter>' +
      '</function></tool_call>'

    const call = detectFallbackToolCall(text, SEARCH_TOOLS)
    expect(call?.name).toBe('read_file')
    expect(call?.arguments).toEqual({ path: 'a.ts' })
    expect(stripFallbackCall(text, call!)).toBe('Checking.')
  })

  it('parses a bare function block with no <tool_call> wrapper', () => {
    const call = detectFallbackToolCall(
      '<function=read_file><parameter=path>a.ts</parameter>',
      SEARCH_TOOLS
    )
    expect(call?.name).toBe('read_file')
    expect(call?.arguments).toEqual({ path: 'a.ts' })
  })

  it('ignores a function block naming a tool that is not registered', () => {
    expect(
      detectFallbackToolCall('<function=launch_missiles><parameter=x>1</parameter>', SEARCH_TOOLS)
    ).toBeNull()
  })

  it('holds streamed text back from the start of a function tag', () => {
    const text = 'Let me search. <function=search_files>'
    expect(findPotentialToolCallTextStart(text)).toBe('Let me search. '.length)
  })
})

describe("Gemma's tool_code dialect", () => {
  const PLAN_TOOLS = new Set(['write_plan', 'read_file', 'edit_file'])

  it('reads the call Gemma actually emits', () => {
    // Measured: Gemma 3 27B could not start a run at all. Every call it made
    // arrived in this shape and nothing recognised it, so no plan was ever
    // produced and the run errored at turn 2. Told "You didn't call
    // write_plan", it apologised and emitted the same block again.
    const text = [
      'Okay, here is the plan.',
      '```tool_code',
      'write_plan(title="Add Camera Bookmarks", steps=["Implement snapshot in camera.py", "Add buttons to ui.py"])',
      '```'
    ].join('\n')

    const call = detectFallbackToolCall(text, PLAN_TOOLS)

    expect(call?.name).toBe('write_plan')
    expect(call?.arguments).toEqual({
      title: 'Add Camera Bookmarks',
      steps: ['Implement snapshot in camera.py', 'Add buttons to ui.py']
    })
  })

  it('keeps a list argument whole rather than splitting on its commas', () => {
    // Splitting naively would produce a call with the wrong shape, which is
    // worse than producing none: a plan is the commonest list-valued argument
    // Anodex receives.
    const text = '```tool_code\nwrite_plan(title="T", steps=["a, with comma", "b"])\n```'

    expect(detectFallbackToolCall(text, PLAN_TOOLS)?.arguments).toEqual({
      title: 'T',
      steps: ['a, with comma', 'b']
    })
  })

  it('reads Python True/False/None', () => {
    const text = '```tool_code\nedit_file(path="a.py", dryRun=True, backup=None)\n```'

    expect(detectFallbackToolCall(text, PLAN_TOOLS)?.arguments).toEqual({
      path: 'a.py',
      dryRun: true,
      backup: null
    })
  })

  it('refuses a name that is not a registered tool', () => {
    // The rule the whole module keeps: never guess a call into existence.
    const text = '```tool_code\ndelete_everything(force=True)\n```'

    expect(detectFallbackToolCall(text, PLAN_TOOLS)).toBeNull()
  })

  it('abandons the call rather than half-understanding its arguments', () => {
    // A value this reader cannot parse means the whole candidate is dropped:
    // a partly-read call would run with arguments the model did not give.
    const text = '```tool_code\nwrite_plan(title=some_variable, steps=[])\n```'

    expect(detectFallbackToolCall(text, PLAN_TOOLS)).toBeNull()
  })

  it('strips the fence from the text the user sees', () => {
    const text = 'Here goes.\n```tool_code\nwrite_plan(title="T", steps=["a"])\n```\nDone.'
    const call = detectFallbackToolCall(text, PLAN_TOOLS)!

    const stripped = stripFallbackCall(text, call)

    expect(stripped).not.toContain('tool_code')
    expect(stripped).toContain('Here goes.')
  })

  it('holds back a fence that is still streaming', () => {
    const text = 'Working on it.\n```tool_code\nwrite_plan(title="T"'

    expect(findPotentialToolCallTextStart(text)).toBeGreaterThan(-1)
  })
})

describe('tool_code with triple-quoted code arguments', () => {
  const TOOLS2 = new Set(['edit_file', 'write_plan'])

  it('reads code passed in a Python triple-quoted string', () => {
    // Measured: DeepSeek-R1-Distill-32B made 4 tool calls in 30 turns. It was
    // emitting `tool_code` correctly, but every edit carried its code as a
    // triple-quoted argument, which is never valid JSON, so the parser
    // abandoned the call and the model narrated edits it never made.
    const text = [
      '```tool_code',
      'edit_file(path="camera.py", oldText="""class Camera:',
      '    def __init__(self, a, b):""", newText="""class Camera:',
      '    def __init__(self, a, b, c):""")',
      '```'
    ].join('\n')

    const call = detectFallbackToolCall(text, TOOLS2)

    expect(call?.name).toBe('edit_file')
    expect(call?.arguments.path).toBe('camera.py')
    expect(String(call?.arguments.oldText)).toContain('def __init__(self, a, b):')
    expect(String(call?.arguments.newText)).toContain('def __init__(self, a, b, c):')
  })

  it('does not split a call down the middle of the code it carries', () => {
    // The code inside a triple-quoted argument contains commas and brackets of
    // its own; splitting on those would produce a call with the wrong shape,
    // which is worse than producing none.
    const text = '```tool_code\nedit_file(path="a.py", oldText="""f(x, y), [1, 2]""")\n```'

    expect(detectFallbackToolCall(text, TOOLS2)?.arguments).toEqual({
      path: 'a.py',
      oldText: 'f(x, y), [1, 2]'
    })
  })

  it('still refuses an unregistered name carrying triple-quoted code', () => {
    const text = '```tool_code\nrm_rf(path="""/""")\n```'

    expect(detectFallbackToolCall(text, TOOLS2)).toBeNull()
  })
})
