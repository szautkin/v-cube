// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Serhii Zautkin and v-cube contributors
/**
 * Random-access byte sources for FITS data. File-backed sources let us read
 * single channel planes from multi-GB cubes without ever holding the whole
 * file in memory (FITS stores spectral cubes plane-by-plane, so a channel
 * read is one contiguous slice).
 */
export interface DataSource {
  readonly name: string;
  readonly size: number;
  read(offset: number, length: number): Promise<ArrayBuffer>;
}

export class BufferSource implements DataSource {
  constructor(
    public readonly name: string,
    private buf: ArrayBuffer,
  ) {}

  get size(): number {
    return this.buf.byteLength;
  }

  async read(offset: number, length: number): Promise<ArrayBuffer> {
    return this.buf.slice(offset, offset + length);
  }
}

export class FileSource implements DataSource {
  constructor(private file: File) {}

  get name(): string {
    return this.file.name;
  }

  get size(): number {
    return this.file.size;
  }

  async read(offset: number, length: number): Promise<ArrayBuffer> {
    return this.file.slice(offset, offset + length).arrayBuffer();
  }
}

/** Fetches the whole file once, then serves slices from memory. */
export async function fetchSource(url: string, onProgress?: (frac: number) => void): Promise<BufferSource> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const name = decodeURIComponent(url.split('/').pop() ?? url);
  if (!res.body || !total) {
    return new BufferSource(name, await res.arrayBuffer());
  }
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, got);
    got += value.byteLength;
    onProgress?.(got / total);
  }
  return new BufferSource(name, out.buffer.slice(0, got) as ArrayBuffer);
}
