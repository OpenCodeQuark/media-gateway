import { AppError } from '../utils/errors.js';

const RANGE_HEADER = /^bytes=(.+)$/i;

/** Parse a single Range header. Multi-range is rejected — browsers use one range for media. */
export function parseRangeHeader(header) {
  if (!header) return null;

  const match = header.trim().match(RANGE_HEADER);
  if (!match) {
    throw new AppError('RANGE_NOT_SATISFIABLE', 'Invalid Range header unit.', {
      details: { header },
    });
  }

  const spec = match[1].trim();
  if (!spec || spec.includes(',')) {
    throw new AppError('RANGE_NOT_SATISFIABLE', 'Multiple or empty byte ranges are not supported.', {
      details: { header },
    });
  }

  if (spec.startsWith('-')) {
    const suffixLength = Number(spec.slice(1));
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      throw new AppError('RANGE_NOT_SATISFIABLE', 'Invalid suffix range.', { details: { header } });
    }
    return { isSuffix: true, suffixLength };
  }

  const [startRaw, endRaw] = spec.split('-');
  if (!startRaw) {
    throw new AppError('RANGE_NOT_SATISFIABLE', 'Invalid byte range.', { details: { header } });
  }

  const start = Number(startRaw);
  if (!Number.isInteger(start) || start < 0) {
    throw new AppError('RANGE_NOT_SATISFIABLE', 'Invalid range start.', { details: { header } });
  }

  if (endRaw === undefined || endRaw === '') {
    return { isSuffix: false, start };
  }

  const end = Number(endRaw);
  if (!Number.isInteger(end) || end < start) {
    throw new AppError('RANGE_NOT_SATISFIABLE', 'Invalid range end.', { details: { header } });
  }

  return { isSuffix: false, start, end };
}

export function resolveByteRange(header, totalSize) {
  if (totalSize < 0 || !Number.isFinite(totalSize)) {
    throw new AppError('INTERNAL_ERROR', 'Invalid media size for range resolution.');
  }

  const parsed = parseRangeHeader(header);
  if (!parsed) return undefined;

  if (totalSize === 0) {
    throw new AppError('RANGE_NOT_SATISFIABLE', 'Range not satisfiable for empty resource.', {
      details: { total: 0 },
    });
  }

  let start;
  let end;

  if (parsed.isSuffix) {
    const suffix = Math.min(parsed.suffixLength, totalSize);
    start = totalSize - suffix;
    end = totalSize - 1;
  } else {
    start = parsed.start;
    if (start >= totalSize) {
      throw new AppError('RANGE_NOT_SATISFIABLE', 'Range start exceeds resource size.', {
        details: { start, total: totalSize },
      });
    }
    end = parsed.end !== undefined ? Math.min(parsed.end, totalSize - 1) : totalSize - 1;
  }

  return {
    start,
    end,
    length: end - start + 1,
    total: totalSize,
    suffix: parsed.isSuffix,
  };
}

export function formatContentRange(range) {
  return `bytes ${range.start}-${range.end}/${range.total}`;
}

export function formatUnsatisfiedContentRange(total) {
  return `bytes */${total}`;
}
