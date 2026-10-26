const VOID_TAGS = new Set(require("./self-closing-tags"));
const NAME_LIMIT = 4096;
const STACK_LIMIT = 16384;
const STACK_UNITS = 1024 * 1024;
const CLOSE_TOKEN_LIMIT = 65536;
let tokenizerPromise;

function limit(message) {
  const error = new RangeError(message);
  error.code = "ERR_TAG_ANALYSIS_LIMIT";
  return error;
}

async function closingTagForSource(source, cursor, { signal, xmlMode = false } = {}) {
  signal?.throwIfAborted();
  const Tokenizer = await (tokenizerPromise ??= import("htmlparser2").then(
    (module) => module.Tokenizer,
  ));
  signal?.throwIfAborted();
  const stack = [];
  let pendingName,
    candidate,
    candidateClosed = false,
    ambiguous = false,
    safeThrough = 0,
    stackUnits = 0;
  const nameAt = (start, end) => {
    if (end - start > NAME_LIMIT) throw limit(`A tag name exceeds ${NAME_LIMIT} UTF-16 units.`);
    const name = source.slice(start, end);
    if (!/^[\p{L}_:][\p{L}\p{N}\p{M}_.:\-\u00b7\u203f-\u2040]*$/u.test(name)) ambiguous = true;
    return { name, key: xmlMode ? name : name.toLowerCase(), start, end };
  };
  const closingEnd = (start) => {
    const end = Math.min(source.length, start + CLOSE_TOKEN_LIMIT);
    for (let offset = start; offset < end; offset += 16384) {
      const chunk = source.slice(offset, Math.min(end, offset + 16384));
      const index = chunk.search(xmlMode ? /[^ \t\r\n]/ : /[^ \t\r\n\f]/);
      if (index >= 0) return chunk[index] === ">" ? offset + index + 1 : null;
    }
    if (end < source.length)
      throw limit(`A closing tag exceeds ${CLOSE_TOKEN_LIMIT} UTF-16 units.`);
    return null;
  };
  const safe = (end) => {
    safeThrough = Math.max(safeThrough, end);
  };
  const noop = () => {};
  const tokenizer = new Tokenizer(
    { xmlMode, decodeEntities: false, recognizeSelfClosing: true },
    {
      onopentagname(start, end) {
        pendingName = nameAt(start, end);
      },
      onopentagend(end) {
        if (!pendingName) {
          ambiguous = true;
          return;
        }
        if (xmlMode || !VOID_TAGS.has(pendingName.key)) {
          stackUnits += pendingName.name.length;
          if (stack.length >= STACK_LIMIT || stackUnits > STACK_UNITS)
            throw limit(
              "Open tag nesting exceeds the tag analysis budget (16384 tags or 1 Mi UTF-16 name units).",
            );
          stack.push(pendingName);
        }
        pendingName = null;
        safe(end + 1);
      },
      onselfclosingtag(end) {
        pendingName = null;
        safe(end + 1);
      },
      onclosetag(start, end) {
        const name = nameAt(start, end);
        const tokenEnd = closingEnd(end);
        if (tokenEnd == null || stack.at(-1)?.key !== name.key) {
          ambiguous = true;
          return;
        }
        const closed = stack.pop();
        stackUnits -= closed.name.length;
        safe(tokenEnd);
        if (candidate && closed === candidate) {
          candidateClosed = true;
          tokenizer.pause();
        }
      },
      ontext(_start, end) {
        safe(end);
      },
      oncomment(_start, end) {
        safe(end + 1);
      },
      oncdata(_start, end) {
        safe(end + 1);
      },
      ondeclaration(_start, end) {
        safe(end + 1);
      },
      onprocessinginstruction(_start, end) {
        safe(end + 1);
      },
      onattribdata: noop,
      onattribentity: noop,
      onattribend: noop,
      onattribname: noop,
      ontextentity: noop,
      onend: noop,
      isInForeignContext: () => stack.some(({ key }) => key === "svg" || key === "math"),
    },
  );
  const feed = async (start, end) => {
    let deadline = performance.now() + 4;
    for (let offset = start; offset < end; offset += 16384) {
      signal?.throwIfAborted();
      tokenizer.write(source.slice(offset, Math.min(end, offset + 16384)));
      if (ambiguous || candidateClosed) return;
      if (performance.now() >= deadline) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        signal?.throwIfAborted();
        deadline = performance.now() + 4;
      }
    }
  };
  await feed(0, cursor);
  if (ambiguous || safeThrough !== cursor || pendingName || !stack.length) return null;
  candidate = stack.at(-1);
  await feed(cursor, source.length);
  signal?.throwIfAborted();
  // Do not finalize incomplete tokenizer state: an unfinished attribute,
  // comment or tag makes the lexical context ambiguous, so inserting is unsafe.
  return !ambiguous && !candidateClosed && !pendingName && safeThrough === source.length
    ? candidate.name
    : null;
}

module.exports = { closingTagForSource };
