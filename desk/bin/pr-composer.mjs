// The new-comment composer on a GitHub PR page: the textarea GitHub writes an uploaded file's tag
// into, and the file input that uploads it. upload-images.mjs uploads through it; nothing submits it.
//
// Found by role and placeholder, never by id: the React PR page's textarea id is a useId that
// changes on every load. The classic page's textarea#new_comment_field is the fallback, for an
// account still served that page.
//   - Review-thread reply boxes are the same kind of textbox and sit above the composer, so the
//     composer is the last match.
//   - The React page renders the file input only once the box is focused, so it is looked for after
//     the click, in the composer's nearest ancestor that holds one and no other textarea (the
//     classic page's is its form): a reply box's input, mounted first, is never the composer's.
//   - Since 18 Nov 2026 GitHub's React page mounts no file input at all: the composer has a "Paste,
//     drop, or click to add files" button that opens a file chooser. Found in the same nearest
//     ancestor, it is used when there is no input (desk-skills#838).

// Shared with the throttle exit: the run stops and nothing is uploaded, so the queue holds every
// repo's uploads rather than spending the PR's tries.
export const EXIT_PAGE_CHANGED = 7;
export const NO_COMPOSER = "GitHub's PR page changed: no comment composer found by role, placeholder or legacy id";
export const NO_FILE_INPUT = "GitHub's PR page changed: the comment composer has no file input or add-files button once focused";

// How long a page that loaded signed in gets to show a composer, and the focused one its file input:
// together inside the 30s a missing composer must be said within.
const COMPOSER_WAIT_MS = 15000;
const FILE_INPUT_WAIT_MS = 5000;

const isTimeout = (e) => e?.name === 'TimeoutError';

// The React composer's add-files button, by its text: it has no aria-label.
const ADD_FILES = 'contains(normalize-space(.), "click to add files")';

// In the order they are preferred; the first that matches anything gives the composer.
const composerLocators = (page) => [
  page.getByRole('textbox', { name: 'Markdown value', exact: true }),
  page.locator('textarea[placeholder="Leave a comment"]'),
  page.locator('textarea#new_comment_field'),
];

// -> null (no composer), { textarea, input: null, setFiles: null } (one, but no way to add files once
// focused), or { textarea, input, setFiles }: the composer's textarea, its hidden file input (null
// when the page has only the add-files button), and setFiles(paths), which uploads through either.
export async function findComposer(page, { wait = COMPOSER_WAIT_MS, focus = FILE_INPUT_WAIT_MS } = {}) {
  const found = composerLocators(page);
  try {
    await found.reduce((a, b) => a.or(b)).first().waitFor({ state: 'attached', timeout: wait });
  } catch (e) {
    if (isTimeout(e)) return null;
    throw e;
  }
  let textarea = null;
  for (const l of found) {
    if (await l.count()) { textarea = l.last(); break; }
  }
  if (!textarea) return null;
  try {
    await textarea.scrollIntoViewIfNeeded({ timeout: focus });
    await textarea.click({ timeout: focus });   // no file input, and no upload POST, until it is focused
    const input = textarea.locator('xpath=ancestor::*[count(.//textarea)=1][.//input[@type="file"]][1]').locator('input[type="file"]').first();
    const button = textarea.locator(`xpath=ancestor::*[count(.//textarea)=1][.//button[${ADD_FILES}]][1]`).locator(`xpath=.//button[${ADD_FILES}]`).first();
    await input.or(button).first().waitFor({ state: 'attached', timeout: focus });
    if (await input.count()) return { textarea, input, setFiles: (paths) => input.setInputFiles(paths) };
    const page = textarea.page();
    const setFiles = async (paths) => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: focus }), button.click({ timeout: focus })]);
      await chooser.setFiles(paths);
    };
    return { textarea, input: null, setFiles };
  } catch (e) {
    if (isTimeout(e)) return { textarea, input: null, setFiles: null };
    throw e;
  }
}
