import { Octokit } from '@octokit/rest';
import fs from 'fs/promises';
import chalk from 'chalk';

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

export async function postComments(prNumber, reportFile) {
  console.log(chalk.blue('📖 Loading report...'));
  
  // Load the report
  const reportContent = await fs.readFile(reportFile, 'utf8');
  const report = JSON.parse(reportContent);
  
  console.log(chalk.green(`✅ Loaded report for PR #${report.prNumber}`));
  console.log(chalk.cyan(`📊 Found ${report.summary.totalComments} comments across ${report.summary.filesWithComments} files`));

  // Fetch PR to get the latest head SHA (needed for line/side comments)
  const { data: pr } = await octokit.pulls.get({
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    pull_number: prNumber,
  });
  const headSha = pr.head.sha;

  // Collect all comments from all files
  const allComments = [];
  
  for (const file of report.files) {
    if (file.comments && file.comments.length > 0) {
      // Build a lookup to map diffPosition -> fileLineNumber derived during analysis
      const posToLine = new Map();
      if (Array.isArray(file.changedLines)) {
        for (const ln of file.changedLines) {
          if (typeof ln.diffPosition === 'number' && typeof ln.fileLineNumber === 'number') {
            posToLine.set(ln.diffPosition, ln.fileLineNumber);
          }
        }
      }

      for (const comment of file.comments) {
        const lineNumber = posToLine.get(comment.diffPosition);
        if (typeof lineNumber === 'number' && lineNumber > 0) {
          allComments.push({
            path: file.filename,
            line: lineNumber,
            side: 'RIGHT', // We only comment on added lines in the new file
            body: formatLineComment(comment, 'comment')
          });
        } else {
          console.log(chalk.yellow(`⚠️  Could not map diffPosition ${comment.diffPosition} to a line number for ${file.filename}`));
        }
      }
    }
  }

  // Use the consolidated overall comment from the report
  const overallComment = report.overallComment;

  console.log(chalk.blue(`📝 Preparing ${allComments.length} line comments for ${report.files.filter(f => f.comments && f.comments.length > 0).length} files...`));

  if (allComments.length === 0 && (!overallComment || overallComment.length === 0)) {
    console.log(chalk.yellow('⚠️  No comments to post'));
    return;
  }

  // Create a single draft review with all comments
  try {
    // Check for existing pending reviews
    const { data: existingReviews } = await octokit.pulls.listReviews({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      pull_number: prNumber,
    });

    const pendingReview = existingReviews.find(review => review.state === 'PENDING');
    
    if (pendingReview) {
      // Update existing pending review
      console.log(chalk.blue(`📝 Found existing pending review, adding ${allComments.length} comments...`));
      
      // Add new comments to existing review
      for (const comment of allComments) {
        await octokit.pulls.createReviewComment({
          owner: process.env.GITHUB_OWNER,
          repo: process.env.GITHUB_REPO,
          pull_number: prNumber,
          body: comment.body,
          commit_id: pendingReview.commit_id,
          path: comment.path,
          line: comment.line,
          side: comment.side
        });
      }

      // Update review body if there is an overall comment
      if (overallComment) {
        const newBody = pendingReview.body 
          ? `${pendingReview.body}\n\n---\n${formatOverallComment(overallComment)}`
          : formatOverallComment(overallComment);
          
        await octokit.pulls.updateReview({
          owner: process.env.GITHUB_OWNER,
          repo: process.env.GITHUB_REPO,
          pull_number: prNumber,
          review_id: pendingReview.id,
          body: newBody
        });
      }

      console.log(chalk.green(`✅ Added ${allComments.length} comments to existing review`));
      
    } else {
      // Create new draft review with all comments
      const reviewBody = overallComment ? formatOverallComment(overallComment) : undefined;

      await octokit.pulls.createReview({
        owner: process.env.GITHUB_OWNER,
        repo: process.env.GITHUB_REPO,
        pull_number: prNumber,
        commit_id: headSha,
        comments: allComments,
        body: reviewBody,
        // No event specified = creates a draft review
      });

      console.log(chalk.green(`✅ Created draft review with ${allComments.length} line comments`));
      console.log(chalk.blue(`📝 You can now edit the review in GitHub before submitting it`));
    }
    
  } catch (error) {
    console.error(chalk.red(`❌ Failed to create/update review:`), error.message);
  }

  console.log(chalk.green('✅ All line comments posted successfully!'));
}

function formatLineComment(item, type) {
  const icon = getIssueIcon(item.type);
  
  let body = `🤖 AI: ${item.message}\n\n`;
  
  return body;
}

function formatOverallComment(overall) {
  return `📋 ${overall}\n\n---\n*Drafted with my new i18n tooling - feedback welcome*`;
}

function getIssueIcon(type) {
  switch (type.toLowerCase()) {
    case 'error':
      return '❌';
    case 'warning':
      return '⚠️';
    case 'info':
      return 'ℹ️';
    default:
      return '📝';
  }
}

export async function deleteEmptyPendingReview(prNumber) {
  try {
    const { data: reviews } = await octokit.pulls.listReviews({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      pull_number: prNumber,
    });
    const pendingReview = reviews.find(r => r.state === 'PENDING');
    if (!pendingReview) {
      console.log('No pending review found.');
      return;
    }
    // Check for comments on the pending review
    const { data: comments } = await octokit.pulls.listCommentsForReview({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      pull_number: prNumber,
      review_id: pendingReview.id,
    });
    if (comments.length === 0) {
      await octokit.pulls.deletePendingReview({
        owner: process.env.GITHUB_OWNER,
        repo: process.env.GITHUB_REPO,
        pull_number: prNumber,
        review_id: pendingReview.id,
      });
      console.log('✅ Deleted empty pending review.');
    } else {
      console.log('❌ Pending review has comments and will not be deleted.');
    }
  } catch (error) {
    console.error('Error deleting pending review:', error.message);
  }
}


 