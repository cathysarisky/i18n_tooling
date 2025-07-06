# Ghost i18n Tooling

A Node.js tool for analyzing Ghost PR changes to i18n locale files and validating them with AI. This tool fetches pull request data, extracts changed lines from i18n files, submits them to an AI API for validation, and can post the results as comments on the PR.

## Features

- 🔍 **i18n PR Analysis**: Fetches and analyzes pull request changes to locale files
- 🤖 **AI Validation**: Uses OpenAI to validate i18n changes and translations
- 📊 **Report Generation**: Creates detailed JSON reports of findings
- 💬 **GitHub Integration**: Posts analysis results as line-specific PR comments
- 🎯 **i18n Focus**: Specializes in translation quality, consistency, and best practices
- ⚡ **Performance Optimized**: Single AI call per PR + filesystem caching for context.json (24 hours)

## File Filtering

This tool **only analyzes files matching the pattern**: `ghost/i18n/locales/**/**.json`

Non-matching files will be displayed with a warning message and skipped from analysis.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Configuration

Copy the example environment file and configure your API keys:

```bash
cp env.example .env
```

Edit `.env` with your actual values:

```env
# GitHub API Configuration
GITHUB_TOKEN=your_github_personal_access_token_here
GITHUB_OWNER=TryGhost
GITHUB_REPO=Ghost

# OpenAI API Configuration
OPENAI_API_KEY=your_openai_api_key_here

```

### 3. API Keys Setup

#### GitHub Token
1. Go to GitHub Settings → Developer settings → Personal access tokens
2. Generate a new token with `repo` permissions
3. Add the token to your `.env` file

#### OpenAI API Key
1. Sign up at [OpenAI](https://platform.openai.com/)
2. Generate an API key
3. Add the key to your `.env` file

## Usage

### Analyze a PR

```bash
# Analyze PR #1234 and save report to ai_validations/1234.json
node index.js analyze 1234

# Analyze with custom output file (still in ai_validations/)
node index.js analyze 1234 -o my-custom-report.json

# Analyze with absolute path
node index.js analyze 1234 -o /path/to/custom/report.json

# NOTE: The `analyze` command never posts comments – it only creates the JSON
#       report. Passing `-d / --dry-run` therefore has no effect and is kept
#       only for CLI consistency. Use `-d` with the `review` command if you
#       want to skip posting comments after analysis.
```

### Post Line Comments from Report

```bash
# Post line comments from a report to PR #1234
node index.js post 1234 ai_validations/1234.json
```

### Clean Pending Reviews

```bash
# Delete empty pending reviews for PR #1234
# ⚠️  WARNING: This will delete ALL pending comments for the PR
node index.js clean-pending 1234
```

**Note**: The `clean-pending` command deletes the entire pending review, including any comments that were already posted. Use this only when you want to start fresh with a new review.

### Complete Review Workflow

```bash
# Run the complete workflow: analyze + post comments
node index.js review 1234
```

This command combines the analyze and post steps into a single workflow.

## Workflow

### Basic Workflow
1. **Analyze PR**: Run the analysis tool on a specific PR
2. **Review Report**: Check the generated JSON report in `ai_validations/`
3. **Edit if needed**: Modify the report file if you want to change comments
4. **Post Line Comments**: Use the post command to submit line-specific comments to the PR

### Quick Workflow
1. **Review**: Use the `review` command to analyze and post comments in one step
2. **Edit in GitHub**: The comments are posted as draft reviews that you can edit before submitting

### Troubleshooting Workflow
1. **Clean Pending**: If you get "one pending review per pull request" errors, use `clean-pending` to remove existing reviews
2. **Re-run**: Then run `review` or `post` again

## Output Structure

Reports are automatically saved to the `ai_validations/` directory with the PR number as the filename:

```
i18n_tooling/
├── ai_validations/
│   ├── 1234.json    # Analysis report for PR #1234
│   ├── 1235.json    # Analysis report for PR #1235
│   └── ...
```

## Report Format

The tool generates a JSON report with the following structure:

```json
{
  "prNumber": 1234,
  "prTitle": "Update French translations",
  "prUrl": "https://github.com/TryGhost/Ghost/pull/1234",
  "analyzedAt": "2024-01-15T10:30:00.000Z",
  "files": [
    {
      "filename": "ghost/i18n/locales/fr/admin.json",
      "status": "modified",
      "additions": 5,
      "deletions": 2,
      "changedLines": 7,
      "issues": [
        {
          "type": "warning",
          "message": "Inconsistent key naming convention",
          "line": "\"admin.settings.general\": \"Paramètres généraux\",",
          "suggestion": "Use consistent dot notation for nested keys"
        }
      ],
      "suggestions": [
        {
          "type": "improvement",
          "message": "Consider adding context comments for complex translations",
          "line": "\"admin.posts.publish\": \"Publier\""
        }
      ],
      "aiSummary": "Good French translations, but needs consistency improvements"
    }
  ],
  "skippedFiles": [
    {
      "filename": "apps/admin/src/components/Button.js",
      "status": "modified"
    }
  ],
  "summary": {
    "totalFiles": 3,
    "i18nFiles": 2,
    "skippedFiles": 1,
    "filesWithIssues": 1,
    "totalIssues": 2
  }
}
```

## AI Analysis Focus

The AI analysis specifically focuses on i18n aspects:

- **Translation Quality**: Accuracy and appropriateness of translations
- **Missing Keys**: Incomplete translation sets
- **Format Consistency**: JSON structure and key organization
- **Cultural Sensitivity**: Appropriate cultural context
- **Technical Issues**: JSON syntax errors or malformed structures
- **Key Naming**: Descriptive and well-organized translation keys
- **Context**: Translations that make sense in their intended context

## Example Output

When analyzing a PR with mixed file types:

```
🔍 Analyzing PR #1234...
📁 Found 5 changed files
⚠️  Skipping 3 non-i18n files:
    - apps/admin/src/components/Button.js (modified)
    - ghost/core/server/models/post.js (modified)
    - README.md (modified)
   Only files matching 'ghost/i18n/locales/**/**.json' will be analyzed.

🔍 Analyzing 2 i18n locale files...
  📄 ghost/i18n/locales/en/errors.json
    📝 Found 3 changed lines
  📄 ghost/i18n/locales/fr/admin.json
    📝 Found 7 changed lines

📊 Analysis complete! Found 4 potential issues in 2 i18n files
```

## Performance Optimizations

### Context.json Caching

The tool caches the `context.json` file to the filesystem for 24 hours to avoid redundant GitHub API calls. This significantly improves performance when analyzing multiple files in a single PR or running multiple analyses in a day.

- **Cache Duration**: 24 hours
- **Cache Location**: `i18n_tooling/cache/context.json`
- **Cache Expiry**: Based on file modification time
- **Logging**: Shows when cache is used vs. when fetching from GitHub

### API Call Optimization

- **Single AI Call**: All files are analyzed together in one OpenAI API call instead of one call per file
- **Context Sharing**: The AI can see patterns across all files and provide better overall analysis
- **Context.json Caching**: Fetched only once per PR analysis, regardless of the number of files
- **Reduced API Usage**: Significantly reduces both GitHub and OpenAI API calls

## Customization

### File Pattern

The file pattern is hardcoded to `ghost/i18n/locales/**/**.json`. If you need to modify this, edit the `i18nPattern` regex in `src/analyzer.js`:

```javascript
const i18nPattern = /^ghost\/i18n\/locales\/.*\.json$/;
```

### AI Prompt

Modify the AI analysis prompt in `src/analyzer.js` to focus on specific i18n aspects:

```javascript
const prompt = `
You are an AI assistant analyzing i18n (internationalization) changes in a Ghost (blogging platform) repository.
// ... customize the prompt here
`;
```

## Troubleshooting

### Common Issues

1. **No i18n files found**: The tool will exit gracefully if no files match the pattern.

2. **GitHub API Rate Limits**: The tool respects GitHub's rate limits. If you hit limits, wait and retry.

3. **OpenAI API Errors**: Check your API key and billing status.

4. **Permission Errors**: Ensure your GitHub token has `repo` permissions.

5. **"One pending review per pull request" error**: This happens when there's already a pending review. Use `clean-pending` to remove it, then re-run your command.

6. **Comments posted to wrong lines**: The tool uses diff positions for comment placement. If comments appear on the wrong lines, check that the diff positions in the report are correct.

### Debug Mode

Add `DEBUG=true` to your `.env` file for more verbose logging.

### Cache Management

The context.json cache automatically expires after 24 hours. If you need to force a refresh of the cache (e.g., if context.json has been updated), delete the cache file:

```bash
rm i18n_tooling/cache/context.json
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details. 