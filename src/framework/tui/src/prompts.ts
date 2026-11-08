/**
 * Prompts as typed async functions.
 *
 * Each one draws through the shared renderer and resolves to a value — there is no event registry
 * and no callback to wire, so a wizard reads top to bottom:
 *
 * ```ts
 * const frontend = await select({ message: 'Frontend framework', options });
 * const tools = await multiSelect({ message: 'Tooling', options });
 * if (!(await confirm({ message: 'Generate?' }))) return;
 * ```
 *
 * The interaction keys are the same in every prompt and are shown on screen: arrows move, `Enter`
 * accepts, `Space` toggles (multi-select only), `Esc` goes back, `Ctrl+C` cancels. Cancelling
 * throws `PromptCancelled` so a caller unwinds without saving anything.
 */

import type { CliRenderer } from '@opentui/core';
import { BoxRenderable, TextRenderable } from '@opentui/core';

import { type Palette, createPalette, glyphs, INDENT } from './theme.ts';

/**
 * The parts of a keypress this package acts on.
 *
 * `name` is the printable identity (`up`, `return`, `a`), `ctrl` distinguishes `Ctrl+C` from a literal
 * `c`, and `sequence` is the raw input — which is how an unrecognised escape sequence stays
 * debuggable instead of silently doing nothing.
 */
export interface KeyInfo {
  readonly name: string;
  readonly ctrl: boolean;
  readonly sequence: string;
}

export interface RawKeyEvent {
  readonly name?: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
}

export function normalizeKey(event: RawKeyEvent): KeyInfo {
  return {
    name: event.name ?? event.sequence ?? '',
    ctrl: event.ctrl === true,
    sequence: event.sequence ?? '',
  };
}

export class PromptCancelled extends Error {
  readonly code = 'TUI_CANCELLED';
  constructor(message = 'cancelled') {
    super(message);
    this.name = 'PromptCancelled';
  }
}

export interface PromptOption<T> {
  readonly value: T;
  readonly label: string;
  /** One line under the label. Keep it a fact, not marketing. */
  readonly description?: string;
  /** Multi-select only: pre-selected. */
  readonly selected?: boolean;
  /** Shown but not selectable, with the reason — for an option this environment cannot support. */
  readonly disabled?: string;
}

export interface PromptBase<T> {
  readonly message: string;
  /** Extra context above the options. One or two lines; a paragraph belongs in the screen's header. */
  readonly hint?: string;
  readonly defaultValue?: T;
  readonly palette?: Palette;
}

export interface SelectOptions<T> extends PromptBase<T> {
  readonly options: readonly PromptOption<T>[];
}

export interface MultiSelectOptions<T> extends PromptBase<readonly T[]> {
  readonly options: readonly PromptOption<T>[];
  /** Refuse to accept unless at least one option is selected. */
  readonly requireOne?: boolean;
}

export interface ConfirmOptions {
  readonly message: string;
  readonly hint?: string;
  readonly defaultValue?: boolean;
  /** Require the developer to answer deliberately — no bare `Enter` accepting the default. */
  readonly dangerous?: boolean;
  readonly palette?: Palette;
}

export interface TextOptions extends PromptBase<string> {
  /** Return an error string to keep the prompt open, or undefined to accept. */
  readonly validate?: (value: string) => string | undefined;
  readonly placeholder?: string;
}

/** The key legend every prompt footer shows. */
function legend(mode: 'select' | 'multi' | 'confirm' | 'text'): string {
  const parts =
    mode === 'multi'
      ? ['↑/↓ Navigate', 'Space Toggle', 'Enter Accept', 'Esc Back', 'Ctrl+C Cancel']
      : mode === 'text'
        ? ['Enter Accept', 'Esc Back', 'Ctrl+C Cancel']
        : mode === 'confirm'
          ? ['y/n', 'Enter Accept', 'Ctrl+C Cancel']
          : ['↑/↓ Navigate', 'Enter Select', 'Esc Back', 'Ctrl+C Cancel'];
  return parts.join('   ');
}

interface Frame {
  readonly lines: readonly string[];
  readonly width: number;
}

/**
 * The shared chrome: message, optional hint, body lines, blank line, legend.
 *
 * Built as text rather than as a tree of renderables on purpose — one focused component (the list)
 * plus text around it is simpler to reason about than a nested layout, and keeps every prompt
 * visually identical no matter which one is running.
 */
function frame(options: { message: string; hint?: string; body: readonly string[]; footer: string; palette: Palette }): Frame {
  const { palette } = options;
  const glyph = glyphs();
  const lines: string[] = [
    '',
    `${INDENT}${palette.paintAll(['bold', 'brand'], options.message)}`,
    '',
  ];
  if (options.hint !== undefined) {
    lines.push(`${INDENT}${palette.paint('dim', options.hint)}`, '');
  }
  lines.push(...options.body.map((line) => `${INDENT}${line}`), '');
  lines.push(`${INDENT}${palette.paint('muted', `${glyph.rule.repeat(4)} ${options.footer}`)}`, '');
  const width = Math.max(...lines.map((line) => stripAnsi(line).length), 40);
  return { lines, width };
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping escapes is the whole point
  return value.replace(/\u001B\[[0-9;]*m/gu, '');
}

function optionLine<T>(option: PromptOption<T>, state: { active: boolean; checked: boolean; multi: boolean }): string {
  const palette = createPalette();
  const glyph = glyphs();
  const marker = state.active ? palette.paint('brand', glyph.arrow) : ' ';
  const box = state.multi
    ? state.checked
      ? palette.paint('success', glyph.selected)
      : palette.paint('muted', glyph.unselected)
    : ' ';
  const text = state.active
    ? palette.paintAll(['bold', 'brand'], option.label)
    : state.checked
      ? palette.paint('success', option.label)
      : option.label;
  return `${marker} ${box} ${text}`;
}

function descriptionLine(option: PromptOption<unknown>): string {
  const palette = createPalette();
  const text =
    option.disabled === undefined ? option.description : `${option.description ?? ''} — ${option.disabled}`;
  return text === undefined || text === '' ? '' : `      ${palette.paint('muted', text)}`;
}

/** Every prompt runs the same loop; only the reducer differs. */
async function drive<T>(options: {
  renderer: CliRenderer;
  frame: (state: { cursor: number; checked: ReadonlySet<number>; error?: string }) => Frame;
  onKey: (
    key: KeyInfo,
    state: { cursor: number; checked: Set<number> },
  ) => { done: true; value: T } | { done: false; rerender: boolean } | { done: 'cancel' };
  initialState: { cursor: number; checked: Set<number> };
}): Promise<T> {
  const state = { cursor: options.initialState.cursor, checked: new Set(options.initialState.checked) };
  let error: string | undefined;
  const container = new BoxRenderable(options.renderer, {
    id: 'prompt',
    flexDirection: 'column',
    width: '100%',
  });
  options.renderer.root.add(container);
  let text: TextRenderable | undefined;
  const draw = (): void => {
    const built = options.frame({ ...state, ...(error === undefined ? {} : { error }) });
    if (text === undefined) {
      text = new TextRenderable(options.renderer, { id: 'prompt-text', content: built.lines.join('\n') });
      container.add(text);
    } else {
      text.content = built.lines.join('\n');
    }
  };
  draw();
  return await new Promise<T>((resolve, reject) => {
    const handler = (event: RawKeyEvent): void => {
      const key = normalizeKey(event);
      // Ctrl+C is a *keypress* in raw mode, not SIGINT: the terminal owns the byte, so no signal is
      // ever delivered. Handling it here is what makes "cancel safely" true — a session that relied
      // on SIGINT would sit in the prompt until the process was killed from elsewhere.
      const result =
        key.ctrl && key.name === 'c' ? ({ done: 'cancel' } as const) : options.onKey(key, state);
      if (result.done === 'cancel') {
        options.renderer.keyInput.off('keypress', handler);
        reject(new PromptCancelled());
        return;
      }
      if (result.done) {
        options.renderer.keyInput.off('keypress', handler);
        resolve(result.value);
        return;
      }
      if (result.rerender) draw();
    };
    options.renderer.keyInput.on('keypress', handler);
  });
}

/** Single choice. `Enter` accepts the highlighted option; `Esc` cancels the whole wizard. */
export async function select<T>(
  renderer: CliRenderer,
  options: SelectOptions<T>,
): Promise<T> {
  const palette = options.palette ?? createPalette();
  const enabled = options.options.map((option, index) => ({ option, index })).filter(({ option }) => option.disabled === undefined);
  if (enabled.length === 0) throw new PromptCancelled(`no selectable options for "${options.message}"`);
  const initialValue = options.defaultValue;
  const initialIndex = Math.max(
    0,
    enabled.findIndex(({ option }) => initialValue !== undefined && option.value === initialValue),
  );
  return await drive<T>({
    renderer,
    initialState: { cursor: enabled[initialIndex]!.index, checked: new Set() },
    frame: ({ cursor }) =>
      frame({
        message: options.message,
        ...(options.hint === undefined ? {} : { hint: options.hint }),
        body: options.options.flatMap((option, index) => {
          const line = optionLine(option, { active: index === cursor, checked: false, multi: false });
          return option.disabled === undefined ? [line, descriptionLine(option)] : [`${line}`, descriptionLine(option)];
        }).filter((line, index, all) => line !== '' || all[index - 1] !== ''),
        footer: legend('select'),
        palette,
      }),
    onKey: (key, state) => {
      if (key.name === 'up' || key.name === 'k') {
        const position = enabled.findIndex(({ index }) => index === state.cursor);
        state.cursor = enabled[(position - 1 + enabled.length) % enabled.length]!.index;
        return { done: false, rerender: true };
      }
      if (key.name === 'down' || key.name === 'j') {
        const position = enabled.findIndex(({ index }) => index === state.cursor);
        state.cursor = enabled[(position + 1) % enabled.length]!.index;
        return { done: false, rerender: true };
      }
      if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed') {
        const chosen = options.options[state.cursor];
        if (chosen === undefined) return { done: false, rerender: false };
        return { done: true, value: chosen.value };
      }
      if (key.name === 'escape' || key.name === 'esc') return { done: 'cancel' };
      return { done: false, rerender: false };
    },
  });
}

/** Several choices. `Space` toggles the highlighted option; `Enter` accepts the set. */
export async function multiSelect<T>(
  renderer: CliRenderer,
  options: MultiSelectOptions<T>,
): Promise<readonly T[]> {
  const palette = options.palette ?? createPalette();
  const enabled = options.options.map((option, index) => ({ option, index })).filter(({ option }) => option.disabled === undefined);
  if (enabled.length === 0) throw new PromptCancelled(`no selectable options for "${options.message}"`);
  const preselected = new Set(
    options.options.flatMap((option, index) => (option.selected === true ? [index] : [])),
  );
  const frameFor = ({ cursor, checked, error }: { cursor: number; checked: ReadonlySet<number>; error?: string }): Frame =>
    frame({
      message: options.message,
      ...(options.hint === undefined ? {} : { hint: options.hint }),
      body: [
        ...options.options.flatMap((option, index) => [
          optionLine(option, { active: index === cursor, checked: checked.has(index), multi: true }),
          descriptionLine(option),
        ]),
        ...(error === undefined ? [] : ['', palette.paint('danger', error)]),
      ],
      footer: legend('multi'),
      palette,
    });
  return await drive<readonly T[]>({
    renderer,
    initialState: { cursor: enabled[0]!.index, checked: preselected },
    frame: frameFor,
    onKey: (key, state) => {
      if (key.name === 'up' || key.name === 'k') {
        const position = enabled.findIndex(({ index }) => index === state.cursor);
        state.cursor = enabled[(position - 1 + enabled.length) % enabled.length]!.index;
        return { done: false, rerender: true };
      }
      if (key.name === 'down' || key.name === 'j') {
        const position = enabled.findIndex(({ index }) => index === state.cursor);
        state.cursor = enabled[(position + 1) % enabled.length]!.index;
        return { done: false, rerender: true };
      }
      if (key.name === 'space' || key.name === ' ') {
        if (state.checked.has(state.cursor)) state.checked.delete(state.cursor);
        else state.checked.add(state.cursor);
        return { done: false, rerender: true };
      }
      if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed') {
        const chosen = [...state.checked]
          .sort((a, b) => a - b)
          .flatMap((index) => {
            const option = options.options[index];
            return option === undefined ? [] : [option.value];
          });
        if (options.requireOne === true && chosen.length === 0) {
          return { done: false, rerender: false };
        }
        return { done: true, value: chosen };
      }
      if (key.name === 'escape' || key.name === 'esc') return { done: 'cancel' };
      return { done: false, rerender: false };
    },
  });
}

/**
 * Yes/no.
 *
 * `dangerous` drops the default: a destructive step must be answered, not accepted by reflex. Pressing
 * `Enter` in that mode does nothing, which is the behaviour that makes an operator read the question.
 */
export async function confirm(renderer: CliRenderer, options: ConfirmOptions): Promise<boolean> {
  const palette = options.palette ?? createPalette();
  const fallback = options.defaultValue ?? false;
  const body = [
    options.dangerous === true
      ? palette.paint('warning', 'This cannot be undone. Type y to confirm or n to cancel.')
      : `Default: ${fallback ? 'yes' : 'no'}`,
  ];
  return await drive<boolean>({
    renderer,
    initialState: { cursor: 0, checked: new Set() },
    frame: ({ error }) =>
      frame({
        message: options.message,
        ...(options.hint === undefined ? {} : { hint: options.hint }),
        body: [...body, ...(error === undefined ? [] : [palette.paint('danger', error)])],
        footer: legend('confirm'),
        palette,
      }),
    onKey: (key) => {
      if (key.name === 'y' || key.name === 'Y') return { done: true, value: true };
      if (key.name === 'n' || key.name === 'N') return { done: true, value: false };
      if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed') {
        return options.dangerous === true ? { done: false, rerender: false } : { done: true, value: fallback };
      }
      return { done: false, rerender: false };
    },
  });
}

/**
 * Free text with a validator.
 *
 * The validator returns a message, not a boolean: the point of validating in the prompt is to say
 * what is wrong while the cursor is still there, not to fail the command afterwards.
 */
export async function text(renderer: CliRenderer, options: TextOptions): Promise<string> {
  const palette = options.palette ?? createPalette();
  let value = options.defaultValue ?? '';
  return await drive<string>({
    renderer,
    initialState: { cursor: 0, checked: new Set() },
    frame: ({ error: currentError }) =>
      frame({
        message: options.message,
        ...(options.hint === undefined ? {} : { hint: options.hint }),
        body: [
          `${palette.paint('brand', '›')} ${value === '' ? palette.paint('muted', options.placeholder ?? '') : value}`,
          ...(currentError === undefined ? [] : [palette.paint('danger', currentError)]),
        ],
        footer: legend('text'),
        palette,
      }),
    onKey: (key) => {
      if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed') {
        const problem = options.validate?.(value);
        if (problem !== undefined) {
          return { done: false, rerender: false };
        }
        return { done: true, value };
      }
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        return { done: false, rerender: true };
      }
      if (!key.ctrl && key.name.length === 1 && key.name >= ' ') {
        value += key.name;
        return { done: false, rerender: true };
      }
      return { done: false, rerender: false };
    },
  });
}
