/**
 * diff-util.js
 * Shared utility for parsing GitHub patch diffs and extracting added lines with their relative line numbers.
 */

/**
 * Parse a single diff hunk header
 * @param {string} header - The @@ line from the diff
 * @returns {Object} Parsed hunk info with oldStart, oldCount, newStart, newCount
 */
export function parseHunkHeader(header) {
    const match = header.match(/^@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
    if (!match) {
        throw new Error(`Invalid hunk header: ${header}`);
    }
    return {
        oldStart: parseInt(match[1]),
        oldCount: parseInt(match[2] || '1'),
        newStart: parseInt(match[3]),
        newCount: parseInt(match[4] || '1')
    };
}

/**
 * Parse a single line from the diff
 */
function parseDiffLine(line) {
    if (line.startsWith(' ')) {
        return { type: 'normal', content: line.substring(1) };
    } else if (line.startsWith('-')) {
        return { type: 'deleted', content: line.substring(1) };
    } else if (line.startsWith('+')) {
        return { type: 'added', content: line.substring(1) };
    } else {
        return { type: 'context', content: line };
    }
}

/**
 * Parse a complete diff and extract added lines with their relative line numbers (for GitHub API)
 * @param {string} diffContent - The raw diff content
 * @returns {Array} Array of objects: { relativeLine, newLine, content }
 */
export function extractAddedLinesWithRelativeNumbers(diffContent) {
    const lines = diffContent.split('\n');
    const addedLines = [];

    let relativeLine = 0;      // Position within the patch used previously
    let newLineNumber = 0;     // Line number in the NEW file (what we need for line/side)

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];

        // Bump the patch position counter for EVERY physical line in the diff
        // (metadata, hunk headers, context, deleted, added, etc.)
        relativeLine++;

        // Handle hunk header to reset newLineNumber
        if (rawLine.startsWith('@@')) {
            // Parse the new-file start line from the hunk header: "@@ -<old> +<new>[,<count>] @@"
            const match = rawLine.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (match) {
                // newLineNumber is the line BEFORE the first line in the hunk, so subtract 1.
                newLineNumber = parseInt(match[1], 10) - 1;
            }
            // Hunk headers have no effect on newLine counting beyond resetting, continue.
            continue;
        }

        // Skip other diff metadata for newLine counting but we've already counted them in relativeLine.
        if (
            rawLine.startsWith('diff --git') ||
            rawLine.startsWith('index ') ||
            rawLine.startsWith('---') ||
            rawLine.startsWith('+++') ||
            rawLine.startsWith('From ') ||
            rawLine.startsWith('Date: ') ||
            rawLine.startsWith('Subject: ')
        ) {
            // These lines don't correspond to either old or new file content.
            continue;
        }

        // Determine how the line affects the NEW file line counter
        if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
            // Added line exists in the new file → increment newLineNumber first
            newLineNumber++;

            addedLines.push({
                relativeLine,                 // For backward-compat / debug
                newLine: newLineNumber,        // Line number in the new file
                content: rawLine.substring(1)  // Strip leading '+'
            });
        } else if (rawLine.startsWith(' ') || rawLine === '') {
            // Context (unchanged) line – exists in both old and new files
            newLineNumber++;
        } else if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
            // Deleted line – exists only in the old file; do NOT bump newLineNumber
            // No action required.
        }
        // Any other kind of line doesn't affect newLineNumber further.
    }

    return addedLines;
} 