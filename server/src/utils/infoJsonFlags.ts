/**
 * The two facts the folder index records about an info.json, found in one
 * forward pass over its bytes instead of a JSON.parse of the whole file.
 *
 * yt-dlp writes the comment list after the metadata, and that list is what
 * makes the file large, hundreds of megabytes on a busy video. Once the
 * description is known, the pass stops at the first element of the top-level
 * `comments` array: memory stays at one chunk plus at most
 * DESCRIPTION_PROBE_BYTES, and the bytes after that element are never read.
 *
 * The answer is the one the rule it replaces gives (`Array.isArray(comments)
 * && comments.length > 0`, `typeof description === 'string' &&
 * description.trim().length > 0`) for valid JSON, with two departures on
 * purpose: the first of two equal keys decides, where a parse keeps the last
 * (yt-dlp's json.dump of a dict cannot write two), and a description literal
 * longer than DESCRIPTION_PROBE_BYTES counts as a description without being
 * decoded.
 *
 * The pass follows strings, escapes and nesting, not every token, so it does
 * not validate the file. A malformed file reads as the valid file it
 * resembles once both facts are settled, since nothing after them is read (a
 * file cut off after its first comment counts as having comments), or when
 * its defect leaves strings and nesting intact: NaN and Infinity, which
 * Python's json writes for a float nan or inf, a stray comma, bytes after
 * the closing brace. A parse of such a file fails, so the rule gave it
 * neither flag. With the scan's flags the console offers no comment or
 * description repair for the video, while the reindex, which parses the
 * file, still skips it. Other defects get whatever the pass makes of the
 * bytes, and the one it rejects is a file that ends inside its top-level
 * object before both facts are known, as a parse of it fails.
 */

export interface InfoJsonFlags {
  /** The top-level `comments` is an array with at least one element */
  hasComments: boolean;
  /** The top-level `description` is a string with more than whitespace in it */
  hasDescription: boolean;
}

/** Raw bytes of the description literal kept to judge it; YouTube caps a description at 5,000 characters */
export const DESCRIPTION_PROBE_BYTES = 64 * 1024;
/** Raw bytes kept of a top-level key: enough for `description` written entirely as \u escapes */
const MAX_KEY_BYTES = 6 * 'description'.length;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;

type WatchedKey = 'comments' | 'description';

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

/** The raw bytes of a string literal, quotes left out, decoded the way JSON.parse does; null when they are no literal */
function decodeLiteral(bytes: number[]): string | null {
  try {
    const value: unknown = JSON.parse(`"${Buffer.from(bytes).toString('utf-8')}"`);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function watchedKeyOf(rawKey: number[]): WatchedKey | null {
  const key = decodeLiteral(rawKey);
  return key === 'comments' || key === 'description' ? key : null;
}

class FlagScanner {
  /** The first value of the file has begun */
  private started = false;
  /** Nothing later in the file can change the answer */
  private done = false;
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** In the top-level object, the next string is a key */
  private expectKey = false;
  /** Raw bytes of the top-level key being read; null while none is */
  private key: number[] | null = null;
  /** The watched key just read, whose colon comes next */
  private keyRead: WatchedKey | null = null;
  /** The watched key whose value starts at the next byte that is not whitespace */
  private valueOf: WatchedKey | null = null;
  /** Right after the `[` of the comment list */
  private atFirstComment = false;
  /** Raw bytes of the description literal being read; null while none is */
  private literal: number[] | null = null;
  private comments: boolean | undefined;
  private description: boolean | undefined;

  /** Feed the next bytes; true once nothing later in the file can change the answer */
  push(chunk: Uint8Array): boolean {
    let i = 0;
    while (i < chunk.length && !this.done) {
      if (this.inString && this.key === null && this.literal === null) {
        i = this.skipString(chunk, i);
      } else {
        this.read(chunk[i] ?? 0);
        i += 1;
      }
    }
    return this.done;
  }

  flags(): InfoJsonFlags {
    return { hasComments: this.comments === true, hasDescription: this.description === true };
  }

  /**
   * Run through a string nobody keeps, the formats' URLs and every value, in a
   * tight loop. The index after its closing quote, or the chunk length when
   * the string runs on into the next chunk.
   */
  private skipString(chunk: Uint8Array, from: number): number {
    let escaped = this.escaped;
    for (let i = from; i < chunk.length; i += 1) {
      const byte = chunk[i];
      if (escaped) {
        escaped = false;
      } else if (byte === BACKSLASH) {
        escaped = true;
      } else if (byte === QUOTE) {
        this.escaped = false;
        this.inString = false;
        return i + 1;
      }
    }
    this.escaped = escaped;
    return chunk.length;
  }

  private read(byte: number): void {
    if (this.inString) {
      this.stringByte(byte);
    } else {
      this.structuralByte(byte);
    }
    if (this.comments !== undefined && this.description !== undefined) {
      this.done = true;
    }
  }

  private stringByte(byte: number): void {
    if (this.escaped) {
      this.escaped = false;
    } else if (byte === BACKSLASH) {
      this.escaped = true;
    } else if (byte === QUOTE) {
      this.inString = false;
      this.closeString();
      return;
    }
    this.keep(byte);
  }

  /** Keep a byte of the top-level key or the description literal being read */
  private keep(byte: number): void {
    if (this.key !== null) {
      if (this.key.length < MAX_KEY_BYTES) {
        this.key.push(byte);
      } else {
        // Too long to be either watched key
        this.key = null;
      }
    } else if (this.literal !== null) {
      if (this.literal.length < DESCRIPTION_PROBE_BYTES) {
        this.literal.push(byte);
      } else {
        // Longer than a description YouTube allows: it counts unread
        this.description = true;
        this.literal = null;
      }
    }
  }

  private closeString(): void {
    if (this.key !== null) {
      this.keyRead = watchedKeyOf(this.key);
      this.key = null;
    } else if (this.literal !== null) {
      const text = decodeLiteral(this.literal);
      this.description = text !== null && text.trim().length > 0;
      this.literal = null;
    }
  }

  private structuralByte(byte: number): void {
    if (isJsonWhitespace(byte)) {
      return;
    }
    if (!this.started) {
      this.start(byte);
      return;
    }
    if (this.atFirstComment) {
      this.atFirstComment = false;
      this.comments = byte !== CLOSE_ARRAY;
    }
    if (this.valueOf !== null) {
      this.openValue(byte);
    }
    this.track(byte);
  }

  private start(byte: number): void {
    this.started = true;
    if (byte !== OPEN_OBJECT) {
      // An array or a scalar has no top-level keys, and a parse finds none either
      this.done = true;
      return;
    }
    this.depth = 1;
    this.expectKey = true;
  }

  /** The first byte of a watched key's value; only the first occurrence of a key decides */
  private openValue(byte: number): void {
    const key = this.valueOf;
    this.valueOf = null;
    if (key === 'comments' && this.comments === undefined) {
      if (byte === OPEN_ARRAY) {
        this.atFirstComment = true;
      } else {
        this.comments = false;
      }
    } else if (key === 'description' && this.description === undefined) {
      if (byte === QUOTE) {
        this.literal = [];
      } else {
        this.description = false;
      }
    }
  }

  /** Strings, nesting and the key and value positions of the top-level object */
  private track(byte: number): void {
    switch (byte) {
      case QUOTE:
        this.inString = true;
        if (this.depth === 1 && this.expectKey) {
          this.key = [];
          this.keyRead = null;
        }
        return;
      case OPEN_OBJECT:
      case OPEN_ARRAY:
        this.depth += 1;
        return;
      case CLOSE_OBJECT:
      case CLOSE_ARRAY:
        this.depth -= 1;
        if (this.depth <= 0) {
          this.done = true;
        }
        return;
      case COLON:
        if (this.depth === 1) {
          this.expectKey = false;
          this.valueOf = this.keyRead;
          this.keyRead = null;
        }
        return;
      case COMMA:
        if (this.depth === 1) {
          this.expectKey = true;
        }
        return;
      default:
        return;
    }
  }
}

/**
 * Scan the chunks of an info.json, stopping the pull once the answer is
 * settled: leaving the loop closes the source, so the rest of a file stream
 * is never read. A whole file settles it at the latest at the brace that
 * closes its top-level object, so a source that runs out first ended inside
 * that object, or before any value at all, and is rejected.
 */
export async function scanInfoJsonFlags(chunks: AsyncIterable<Uint8Array>): Promise<InfoJsonFlags> {
  const scanner = new FlagScanner();
  for await (const chunk of chunks) {
    if (scanner.push(chunk)) {
      return scanner.flags();
    }
  }
  throw new Error('The info.json ends before its top-level object does');
}
