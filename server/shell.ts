// A small POSIX shell lexer, enough to tell which programs a command line runs and how they are chained.
// It drops quotes, comments, redirections and heredoc bodies, and keeps $(...) and `...` as part of a word.

export type Operator = "|" | "&&" | "||" | ";" | "&";

export interface Segment {
  /** The simple command's words, unquoted. */
  argv: string[];
  /** What follows it: "|" pipes its output into the next segment; null for the last one. */
  next: Operator | null;
}

type NextWord = "arg" | "target" | "heredoc" | "heredoc-strip";

export function shellSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  const heredocs: { delimiter: string; strip: boolean }[] = [];
  let argv: string[] = [];
  let word: string | null = null;
  let nextWord: NextWord = "arg";
  let i = 0;

  const endWord = () => {
    if (word === null) return;
    if (nextWord === "arg") argv.push(word);
    else if (nextWord !== "target") heredocs.push({ delimiter: word, strip: nextWord === "heredoc-strip" });
    nextWord = "arg";
    word = null;
  };
  const endSegment = (next: Operator | null) => {
    endWord();
    if (argv.length > 0) segments.push({ argv, next });
    else if (next === "|" || next === "||" || next === "&&") {
      // `( npm test ) | tail`: the operator after a group belongs to the group's last command.
      const last = segments.at(-1);
      if (last) last.next = next;
    }
    argv = [];
  };
  const append = (text: string) => {
    word = (word ?? "") + text;
  };
  /** Index just past the `)` that closes the `(` at `start`, skipping quoted text. */
  const closeParen = (start: number) => {
    let depth = 0;
    for (let j = start; j < command.length; j++) {
      const c = command[j];
      if (c === "\\") j++;
      else if (c === "'") j = Math.max(j, command.indexOf("'", j + 1));
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return j + 1;
    }
    return command.length;
  };
  const skipHeredocBodies = () => {
    for (const { delimiter, strip } of heredocs.splice(0)) {
      while (i < command.length) {
        const end = command.indexOf("\n", i);
        const line = command.slice(i, end < 0 ? command.length : end);
        i = end < 0 ? command.length : end + 1;
        if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
      }
    }
  };

  while (i < command.length) {
    const c = command[i]!;
    const d = command[i + 1];
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
    } else if (c === "\\") {
      if (d !== "\n" && d !== undefined) append(d);
      i += 2;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      append(command.slice(i + 1, end < 0 ? command.length : end));
      i = end < 0 ? command.length : end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let text = "";
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length && '"\\$`\n'.includes(command[j + 1]!)) j++;
        text += command[j++];
      }
      append(text);
      i = j + 1;
    } else if (c === "`") {
      const end = command.indexOf("`", i + 1);
      append(command.slice(i, end < 0 ? command.length : end + 1));
      i = end < 0 ? command.length : end + 1;
    } else if (c === "$" && d === "(") {
      const end = closeParen(i + 1);
      append(command.slice(i, end));
      i = end;
    } else if (c === "#" && word === null) {
      while (i < command.length && command[i] !== "\n") i++;
    } else if (c === "\n") {
      endSegment(";");
      i++;
      skipHeredocBodies();
    } else if (c === ";") {
      endSegment(";");
      i += d === ";" ? 2 : 1;
    } else if (c === "&" && d === "&") {
      endSegment("&&");
      i += 2;
    } else if (c === "|" && d === "|") {
      endSegment("||");
      i += 2;
    } else if (c === "|") {
      endSegment("|");
      i += d === "&" ? 2 : 1;
    } else if (c === "&" && d === ">") {
      endWord();
      i += command[i + 2] === ">" ? 3 : 2;
      nextWord = "target";
    } else if (c === "&") {
      endSegment("&");
      i++;
    } else if (c === "(" || c === ")") {
      endSegment(";");
      i++;
    } else if (c === "<" || c === ">") {
      // A file descriptor number right before the operator (2>) is part of it.
      if (word !== null && /^\d+$/.test(word)) word = null;
      else endWord();
      if (c === "<" && d === "<" && command[i + 2] === "<") {
        i += 3;
        nextWord = "target";
      } else if (c === "<" && d === "<") {
        const strip = command[i + 2] === "-";
        i += strip ? 3 : 2;
        nextWord = strip ? "heredoc-strip" : "heredoc";
      } else {
        i += d === ">" || d === "|" || d === "&" ? 2 : 1;
        // 2>&1, >&2, <&-: the target is a descriptor, not a word.
        const fd = d === "&" ? /^(?:\d+|-)/.exec(command.slice(i, i + 12)) : null;
        if (fd) i += fd[0].length;
        else nextWord = "target";
      }
    } else {
      append(c);
      i++;
    }
  }
  endSegment(null);
  return segments;
}
