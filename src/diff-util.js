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
    let relativeLine = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip file headers and metadata
        if (
            line.startsWith('---') || line.startsWith('+++') ||
            line.startsWith('index ') || line.startsWith('diff --git') ||
            line.startsWith('From ') || line.startsWith('Date: ') ||
            line.startsWith('Subject: ') ||
            line.startsWith('@@')
        ) {
            continue;
        }

        // Increment relativeLine for every line in the patch (except metadata and hunk headers)
        relativeLine++;
        if (line.startsWith('+')) {
            addedLines.push({
                relativeLine,
                content: line.substring(1),
                newLine: null // can be filled if needed
            });
        }
    }

    return addedLines;
} 