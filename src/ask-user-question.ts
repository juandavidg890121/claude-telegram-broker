import type { AskUserQuestionInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import type { AskQuestion } from './asks.js';

/**
 * Render an AskUserQuestion into the text a phone notification shows.
 *
 * Importable, rather than living inside the hook script: a hook is an entry
 * point — it calls main() at the top level and reads real stdin on import — so
 * anything worth testing has to live outside it. The alternative, copying the
 * function into the test, tests the copy: the hook can then be changed to
 * return anything at all and the suite stays green.
 *
 * The options are the point. AskUserQuestion exists to make you pick between
 * concrete choices, so a notification with the question and not the options
 * tells you a decision is waiting without telling you what it is — which is
 * barely better than the silence this feature exists to replace.
 */

/**
 * The shape is the SDK's own, not a hand-written guess, because a guess drifts
 * silently: the copy this replaces declared `question` and `header` optional
 * when the SDK requires both, and omitted `options` entirely — so the code was
 * written against a payload that does not exist.
 *
 * The payload still arrives as JSON from outside the process, so the *values*
 * are checked at runtime rather than trusted. The type says what to expect; it
 * cannot promise the hook was handed it.
 */
type Question = AskUserQuestionInput['questions'][number];

const MAX_OPTIONS_SHOWN = 4;

function renderOptions(options: Question['options']): string {
  const labels = options.map((option) => option.label).filter(Boolean);
  if (labels.length === 0) return '';
  // Labels only. The descriptions are often a sentence each, and four of those
  // turn a glanceable notification into something you have to read — when the
  // answer has to be typed in VS Code anyway.
  const shown = labels.slice(0, MAX_OPTIONS_SHOWN);
  const rest = labels.length - shown.length;
  return `\n  ${shown.join(' / ')}${rest > 0 ? ` / +${rest} more` : ''}`;
}

/**
 * One question as a Telegram message body.
 *
 * The buttons carry the labels, so this carries what a button cannot: the
 * descriptions that make the labels mean anything, and whether more than one may
 * be picked. summarize() above is the *notification* form — one glanceable line
 * per question; this is the form you actually answer.
 */
export function renderQuestion(question: AskQuestion, index: number, total: number): string {
  const counter = total > 1 ? ` (${index + 1}/${total})` : '';
  const header = question.header ? `[${question.header}] ` : '';
  const lines = question.options.map(
    (option) => `• ${option.label}${option.description ? ` — ${option.description}` : ''}`,
  );
  // Named rather than left to be discovered. Other is how you answer a question
  // whose real answer Claude did not think of — which is exactly the case where
  // you are least likely to go hunting for an extra button.
  const other = '\n✏️ Other — tap it and type your own answer.';
  const multi = question.multiSelect ? '\n\nPick any, then press Done.' : '';
  return `❓${counter} ${header}${question.question}\n\n${lines.join('\n')}${other}${multi}`;
}

/** An option by index, the multi-select commit, or "none of these, let me type". */
export type AskChoice = number | 'done' | 'other';

/** Telegram caps callback_data at 64 bytes, so this carries indices, never labels. */
export function askCallbackData(id: string, questionIndex: number, choice: AskChoice): string {
  return `ask:${id}:${questionIndex}:${choice}`;
}

export type AskCallback = { id: string; questionIndex: number; choice: AskChoice };

/** The inverse. Undefined for anything that is not one of ours, or is malformed. */
export function parseAskCallback(data: string): AskCallback | undefined {
  const [kind, id, question, choice] = data.split(':');
  if (kind !== 'ask' || !id || question === undefined || choice === undefined) return undefined;

  const questionIndex = Number(question);
  if (!Number.isInteger(questionIndex) || questionIndex < 0) return undefined;
  if (choice === 'done' || choice === 'other') return { id, questionIndex, choice };

  const optionIndex = Number(choice);
  if (!Number.isInteger(optionIndex) || optionIndex < 0) return undefined;
  return { id, questionIndex, choice: optionIndex };
}

/**
 * Answers in the shape the tool consumes: keyed by question *text*, one string
 * per question, several picks joined.
 *
 * Keyed by text because that is the harness's contract, not a preference — it
 * looks the answer up by question string, and an index-keyed payload is silently
 * ignored, which is indistinguishable from never having answered.
 *
 * The join is a guess the payload cannot settle: `answers` is typed as a map of
 * strings, so a multi-select has to flatten into one, and comma-and-space is how
 * a list of labels reads back most naturally.
 */
export function toAnswers(questions: AskQuestion[], picked: Map<number, string[]>): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const [index, labels] of picked) {
    const question = questions[index];
    if (question && labels.length > 0) answers[question.question] = labels.join(', ');
  }
  return answers;
}

export function summarize(input: Partial<AskUserQuestionInput> | undefined): string {
  const questions = input?.questions ?? [];
  // Defensive rather than decorative: this is parsed from a hook's stdin, so
  // "the tool fired with no readable question" is a real state, and saying so
  // beats a notification that is silently empty.
  if (!Array.isArray(questions) || questions.length === 0) return '(no question text available)';

  return questions
    .map((question) => {
      const header = question?.header ? `[${question.header}] ` : '';
      const body = question?.question ?? '(untitled)';
      const options = Array.isArray(question?.options) ? renderOptions(question.options) : '';
      const multi = question?.multiSelect ? ' (pick any)' : '';
      return `• ${header}${body}${multi}${options}`;
    })
    .join('\n');
}
