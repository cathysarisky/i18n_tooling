import dotenv from 'dotenv';
import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';
import chalk from 'chalk';

// Load environment variables
dotenv.config();

async function testSetup() {
  console.log(chalk.blue('🧪 Testing i18n tooling setup...\n'));

  // Test environment variables
  console.log(chalk.cyan('📋 Checking environment variables...'));
  const requiredVars = [
    'GITHUB_TOKEN',
    'GITHUB_OWNER', 
    'GITHUB_REPO',
    'OPENAI_API_KEY'
  ];

  let allVarsPresent = true;
  for (const varName of requiredVars) {
    if (process.env[varName]) {
      console.log(chalk.green(`  ✅ ${varName}: ${varName.includes('TOKEN') || varName.includes('KEY') ? '***' : process.env[varName]}`));
    } else {
      console.log(chalk.red(`  ❌ ${varName}: Missing`));
      allVarsPresent = false;
    }
  }

  if (!allVarsPresent) {
    console.log(chalk.red('\n❌ Missing required environment variables. Please check your .env file.'));
    return;
  }

  console.log(chalk.green('\n✅ All environment variables present'));

  // Test GitHub API
  console.log(chalk.cyan('\n🔗 Testing GitHub API connection...'));
  try {
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });

    const { data: repo } = await octokit.repos.get({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
    });

    console.log(chalk.green(`  ✅ GitHub API: Connected to ${repo.full_name}`));
    console.log(chalk.gray(`     Description: ${repo.description || 'No description'}`));
    console.log(chalk.gray(`     Stars: ${repo.stargazers_count}`));
  } catch (error) {
    console.log(chalk.red(`  ❌ GitHub API: ${error.message}`));
    return;
  }

  // Test OpenAI API
  console.log(chalk.cyan('\n🤖 Testing OpenAI API connection...'));
  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: "Say 'Hello from Ghost i18n tooling!'"
        }
      ],
      max_tokens: 10,
    });

    console.log(chalk.green(`  ✅ OpenAI API: Connected successfully`));
    console.log(chalk.gray(`     Response: ${completion.choices[0].message.content}`));
  } catch (error) {
    console.log(chalk.red(`  ❌ OpenAI API: ${error.message}`));
    return;
  }

  console.log(chalk.green('\n🎉 All tests passed! Your setup is ready to use.'));
  console.log(chalk.blue('\nNext steps:'));
  console.log(chalk.gray('  1. Find a PR number to analyze'));
  console.log(chalk.gray('  2. Run: node index.js analyze <PR_NUMBER>'));
  console.log(chalk.gray('  3. Review the generated report'));
  console.log(chalk.gray('  4. Run: node index.js post <PR_NUMBER> <REPORT_FILE>'));
}

// Run the test
testSetup().catch(error => {
  console.error(chalk.red('❌ Test failed:'), error.message);
  process.exit(1);
}); 