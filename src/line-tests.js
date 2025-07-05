/**
 * Line Number Analyzer for GitHub Patches
 * 
 * This module parses GitHub patch files and calculates the correct line numbers
 * for placing comments on new lines rather than deleted lines.
 * 
 * Based on the algorithm described in the forum thread:
 * - Track relative line numbers across chunks
 * - For added lines, use the relative line number for GitHub API
 * - For deleted lines, skip them in the relative counting
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractAddedLinesWithRelativeNumbers } from './diff-util.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Parse a single diff hunk header
 * @param {string} header - The @@ line from the diff
 * @returns {Object} Parsed hunk info with oldStart, oldCount, newStart, newCount
 */
function parseHunkHeader(header) {
    // Format: @@ -oldStart,oldCount +newStart,newCount @@
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
 * @param {string} line - The diff line
 * @returns {Object} Parsed line info with type, content, oldLine, newLine
 */
function parseDiffLine(line) {
    if (line.startsWith(' ')) {
        return {
            type: 'normal',
            content: line.substring(1),
            oldLine: null,
            newLine: null
        };
    } else if (line.startsWith('-')) {
        return {
            type: 'deleted',
            content: line.substring(1),
            oldLine: null,
            newLine: null
        };
    } else if (line.startsWith('+')) {
        return {
            type: 'added',
            content: line.substring(1),
            oldLine: null,
            newLine: null
        };
    } else {
        return {
            type: 'context',
            content: line,
            oldLine: null,
            newLine: null
        };
    }
}

/**
 * Parse a complete diff and calculate line numbers
 * @param {string} diffContent - The raw diff content
 * @returns {Array} Array of parsed files with line mappings
 */
function parseDiff(diffContent) {
    const lines = diffContent.split('\n');
    const files = [];
    let currentFile = null;
    let currentHunk = null;
    let relativeLine = 0;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Start of a new file
        if (line.startsWith('diff --git')) {
            if (currentFile) {
                files.push(currentFile);
            }
            currentFile = {
                filename: line.split(' ')[2].substring(2), // Remove 'a/' prefix
                hunks: [],
                lineMappings: []
            };
            currentHunk = null;
            relativeLine = 0;
            continue;
        }
        
        // Hunk header
        if (line.startsWith('@@')) {
            if (currentFile) {
                if (currentHunk) {
                    currentFile.hunks.push(currentHunk);
                }
                currentHunk = {
                    header: parseHunkHeader(line),
                    changes: [],
                    relativeLineStart: relativeLine
                };
            }
            continue;
        }
        
        // Skip file headers and metadata
        if (line.startsWith('---') || line.startsWith('+++') || 
            line.startsWith('index ') || line.startsWith('From ') || 
            line.startsWith('Date: ') || line.startsWith('Subject: ')) {
            continue;
        }
        
        // Parse diff lines within a hunk
        if (currentHunk && (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+'))) {
            const parsedLine = parseDiffLine(line);
            
            // Calculate line numbers
            if (parsedLine.type === 'normal') {
                relativeLine++;
                parsedLine.oldLine = currentHunk.header.oldStart + currentHunk.changes.filter(c => c.type === 'normal' || c.type === 'deleted').length;
                parsedLine.newLine = currentHunk.header.newStart + currentHunk.changes.filter(c => c.type === 'normal' || c.type === 'added').length;
            } else if (parsedLine.type === 'deleted') {
                parsedLine.oldLine = currentHunk.header.oldStart + currentHunk.changes.filter(c => c.type === 'normal' || c.type === 'deleted').length;
                // Don't increment relativeLine for deleted lines
            } else if (parsedLine.type === 'added') {
                relativeLine++;
                parsedLine.newLine = currentHunk.header.newStart + currentHunk.changes.filter(c => c.type === 'normal' || c.type === 'added').length;
            }
            
            currentHunk.changes.push(parsedLine);
            
            // Store mapping for added lines (these are where we can place comments)
            if (parsedLine.type === 'added') {
                currentFile.lineMappings.push({
                    relativeLine: relativeLine,
                    newLine: parsedLine.newLine,
                    content: parsedLine.content,
                    type: 'added'
                });
            }
        }
    }
    
    // Add the last hunk and file
    if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
    }
    if (currentFile) {
        files.push(currentFile);
    }
    
    return files;
}

/**
 * Get line numbers for placing comments on added lines
 * @param {Array} parsedFiles - Output from parseDiff
 * @returns {Array} Array of line numbers suitable for GitHub API
 */
function getCommentLineNumbers(parsedFiles) {
    const commentLines = [];
    
    for (const file of parsedFiles) {
        for (const mapping of file.lineMappings) {
            commentLines.push({
                filename: file.filename,
                line: mapping.relativeLine,
                content: mapping.content,
                newLine: mapping.newLine
            });
        }
    }
    
    return commentLines;
}

/**
 * Test function to demonstrate the line number calculation
 */
function testLineNumberCalculation() {
    console.log('Testing line number calculation...\n');
    
    // Read the test patch file
    const patchPath = path.join(__dirname, 'test.patch');
    const patchContent = fs.readFileSync(patchPath, 'utf8');
    
    // Parse the diff
    const parsedFiles = parseDiff(patchContent);
    
    console.log('Parsed Files:');
    for (const file of parsedFiles) {
        console.log(`\nFile: ${file.filename}`);
        console.log(`Hunks: ${file.hunks.length}`);
        console.log(`Added lines: ${file.lineMappings.length}`);
        
        // Show some example line mappings
        for (let i = 0; i < Math.min(5, file.lineMappings.length); i++) {
            const mapping = file.lineMappings[i];
            console.log(`  Line ${mapping.relativeLine}: "${mapping.content.substring(0, 50)}..."`);
        }
    }
    
    // Get comment line numbers
    const commentLines = getCommentLineNumbers(parsedFiles);
    
    console.log('\nComment Line Numbers:');
    for (const comment of commentLines.slice(0, 10)) { // Show first 10
        console.log(`${comment.filename}:${comment.line} - "${comment.content.substring(0, 50)}..."`);
    }
    
    return {
        parsedFiles,
        commentLines
    };
}

/**
 * Create a simple test diff for validation
 */
function createTestDiff() {
    return `diff --git a/test.js b/test.js
index 2aa9a08..066fc99 100644
--- a/test.js
+++ b/test.js
@@ -2,14 +2,7 @@

 var hello = require('./hello.js');

-var names = [
-  'harry',
-  'barry',
-  'garry',
-  'harry',
-  'barry',
-  'marry',
-];
+var names = ['harry', 'barry', 'garry', 'harry', 'barry', 'marry'];

 var names2 = [
   'harry',
@@ -23,9 +16,7 @@ var names2 = [
 // after this line new chunk will be created
 var names3 = [
   'harry',
-  'barry',
-  'garry',
   'harry',
   'barry',
-  'marry',
+  'marry', 'garry',
 ];
`;
}

/**
 * Test with the simple example from the forum thread
 */
function testSimpleExample() {
    console.log('\n=== Testing Simple Example ===\n');
    
    const testDiff = createTestDiff();
    const parsedFiles = parseDiff(testDiff);
    
    console.log('Expected output based on forum thread:');
    console.log('Line 12: add - var names = [\'harry\', \'barry\', \'garry\', \'harry\', \'barry\', \'marry\'];');
    console.log('Line 25: add - \'marry\', \'garry\',');
    
    console.log('\nActual output:');
    const commentLines = getCommentLineNumbers(parsedFiles);
    for (const comment of commentLines) {
        console.log(`Line ${comment.line}: ${comment.type} - ${comment.content}`);
    }
}

/**
 * Test the new diff-util implementation
 */
function testDiffUtil() {
    console.log('\n=== Testing diff-util.js ===\n');
    
    const testDiff = createTestDiff();
    const addedLines = extractAddedLinesWithRelativeNumbers(testDiff);
    
    console.log('Expected output based on forum thread:');
    console.log('Line 12: add - var names = [\'harry\', \'barry\', \'garry\', \'harry\', \'barry\', \'marry\'];');
    console.log('Line 25: add - \'marry\', \'garry\',');
    
    console.log('\nActual output from diff-util.js:');
    for (const line of addedLines) {
        console.log(`Line ${line.relativeLine}: ${line.content}`);
    }
}

// Export functions for use in other modules
export {
    parseDiff,
    parseHunkHeader,
    parseDiffLine,
    getCommentLineNumbers,
    testLineNumberCalculation,
    testSimpleExample,
    testDiffUtil
};

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    testLineNumberCalculation();
    testSimpleExample();
    testDiffUtil();
}
