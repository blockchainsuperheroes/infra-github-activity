import fetch from "node-fetch";
import fs from "fs-extra";
import { PDFDocument, rgb } from "pdf-lib";

// NOTE: jsdom / chart.js / canvas were imported here previously but are never
// used by this Node script — the charts are rendered client-side in the browser
// via a CDN <script>, and createCanvas/JSDOM were never called. The native
// `canvas` module also failed to load on the CI runner, which aborted module
// evaluation before run() ever started (the step finished in ~0.5s with zero
// output yet was reported as success). Removing these dead imports eliminates
// that failure entirely. See package.json.

// Surface any failure loudly so a crash can never again be silently swallowed.
process.on("unhandledRejection", (err) => {
    console.error("❌ Unhandled promise rejection:", err);
    process.exit(1);
});
process.on("uncaughtException", (err) => {
    console.error("❌ Uncaught exception:", err);
    process.exit(1);
});

// -------------------- CONFIG --------------------
const ORG = "blockchainsuperheroes";
const TOKEN = process.env.GH_PAT || "token_read_access"; // GitHub PAT (repo read access)

// -------------------- FETCH REPOS --------------------
async function getRepos() {
    try {
        const allRepos = [];
        let page = 1;
        let hasMore = true;
        
        while (hasMore) {
            const res = await fetch(`https://api.github.com/orgs/${ORG}/repos?per_page=100&sort=pushed&page=${page}`, {
                headers: { Authorization: `Bearer ${TOKEN}` }
            });
            
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }
            
            const repos = await res.json();
            
            if (!Array.isArray(repos) || repos.length === 0) {
                hasMore = false;
                break;
            }
            
            allRepos.push(...repos);
            
            // Check if there are more pages
            const link = res.headers.get("link");
            hasMore = link && link.includes('rel="next"');
            page++;
            
            console.log(`   Fetched page ${page - 1}: ${repos.length} repos (Total: ${allRepos.length})`);
        }
        
        console.log(`✅ Total repositories fetched: ${allRepos.length}`);
        return allRepos;
    } catch (error) {
        console.error(`❌ Error fetching repositories: ${error.message}`);
        throw error;
    }
}

// -------------------- COMMITS COUNT --------------------
async function getCommitCount(repo) {
    try {
        const res = await fetch(`https://api.github.com/repos/${ORG}/${repo.name}/commits?per_page=1`, {
            headers: { Authorization: `Bearer ${TOKEN}` }
        });

        if (!res.ok) {
            console.warn(`⚠️  Could not fetch commits for ${repo.name}: HTTP ${res.status}`);
            return 0;
        }

        const link = res.headers.get("link");
        if (!link) return 0;

        const match = link.match(/&page=(\d+)>; rel="last"/);
        return match ? parseInt(match[1]) : 0;
    } catch (error) {
        console.warn(`⚠️  Error fetching commit count for ${repo.name}: ${error.message}`);
        return 0;
    }
}

// -------------------- GET COMMITS WITH DATES (LAST YEAR) --------------------
async function getCommitsWithDates(repo) {
    try {
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        const since = oneYearAgo.toISOString().split('T')[0];
        
        const commits = [];
        let page = 1;
        let hasMore = true;
        
        while (hasMore && page <= 10) { // Limit to 10 pages to avoid rate limits
            const res = await fetch(
                `https://api.github.com/repos/${ORG}/${repo.name}/commits?per_page=100&page=${page}&since=${since}`,
                { headers: { Authorization: `Bearer ${TOKEN}` } }
            );
            
            if (!res.ok) {
                console.warn(`⚠️  Could not fetch commits for ${repo.name}: HTTP ${res.status}`);
                break;
            }
            
            const pageCommits = await res.json();
            if (!Array.isArray(pageCommits) || pageCommits.length === 0) {
                hasMore = false;
                break;
            }
            
            commits.push(...pageCommits.map(c => ({
                date: c.commit.author.date,
                sha: c.sha
            })));
            
            // Check if there are more pages
            const link = res.headers.get("link");
            hasMore = link && link.includes('rel="next"');
            page++;
        }
        
        return commits;
    } catch (error) {
        console.warn(`⚠️  Error fetching commits with dates for ${repo.name}: ${error.message}`);
        return [];
    }
}

// -------------------- GROUP COMMITS BY WEEK --------------------
function groupCommitsByWeek(commits) {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    oneYearAgo.setHours(0, 0, 0, 0);
    
    const weeklyData = new Map();
    
    // Initialize all weeks in the last year
    for (let i = 0; i < 52; i++) {
        const weekStart = new Date(oneYearAgo);
        weekStart.setDate(weekStart.getDate() + (i * 7));
        const weekKey = getWeekKey(weekStart);
        weeklyData.set(weekKey, { week: weekKey, count: 0 });
    }
    
    commits.forEach(commit => {
        const date = new Date(commit.date);
        if (date < oneYearAgo) return;
        
        const weekKey = getWeekKey(date);
        if (!weeklyData.has(weekKey)) {
            weeklyData.set(weekKey, { week: weekKey, count: 0 });
        }
        
        weeklyData.get(weekKey).count++;
    });
    
    // Convert to array and sort by week
    return Array.from(weeklyData.values())
        .sort((a, b) => a.week.localeCompare(b.week))
        .filter(w => {
            const weekDate = new Date(w.week);
            return weekDate >= oneYearAgo;
        });
}

// -------------------- GROUP CODE FREQUENCY BY WEEK --------------------
function groupCodeFrequencyByWeek(codeFreq) {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    oneYearAgo.setHours(0, 0, 0, 0);
    
    const weeklyData = new Map();
    
    // Initialize all weeks in the last year
    for (let i = 0; i < 52; i++) {
        const weekStart = new Date(oneYearAgo);
        weekStart.setDate(weekStart.getDate() + (i * 7));
        const weekKey = getWeekKey(weekStart);
        weeklyData.set(weekKey, { week: weekKey, additions: 0, deletions: 0 });
    }
    
    codeFreq.forEach(item => {
        // Code frequency data: [timestamp (seconds), additions, deletions]
        const date = new Date(item[0] * 1000);
        if (date < oneYearAgo) return;
        
        const weekKey = getWeekKey(date);
        if (!weeklyData.has(weekKey)) {
            weeklyData.set(weekKey, { week: weekKey, additions: 0, deletions: 0 });
        }
        
        const weekData = weeklyData.get(weekKey);
        weekData.additions += (item[1] || 0);
        weekData.deletions += (item[2] || 0);
    });
    
    // Convert to array and sort by week
    return Array.from(weeklyData.values())
        .sort((a, b) => a.week.localeCompare(b.week))
        .filter(w => {
            const weekDate = new Date(w.week);
            return weekDate >= oneYearAgo;
        });
}

function getWeekKey(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    // Get Monday of the week
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
    const monday = new Date(d.setDate(diff));
    return monday.toISOString().split('T')[0];
}

// -------------------- CODE FREQUENCY --------------------
async function getCodeFrequency(repo) {
    try {
        const res = await fetch(`https://api.github.com/repos/${ORG}/${repo.name}/stats/code_frequency`, {
            headers: { Authorization: `Bearer ${TOKEN}` }
        });
        
        // GitHub stats API returns 202 when calculating, or 204 when no content
        if (res.status === 202 || res.status === 204) {
            // Stats are being calculated or no content, return empty array
            return [];
        }
        
        // Check if response has content
        const text = await res.text();
        if (!text || text.trim() === '') {
            return [];
        }
        
        // Try to parse JSON
        let data;
        try {
            data = JSON.parse(text);
        } catch (parseError) {
            // Invalid JSON, return empty array
            console.warn(`⚠️  Could not parse code frequency for ${repo.name}: ${parseError.message}`);
            return [];
        }
        
        // Return empty array if data is null, not an array, or empty
        if (!data || !Array.isArray(data) || data.length === 0) {
            return [];
        }
        
        return data;
    } catch (error) {
        // Network or other errors
        console.warn(`⚠️  Error fetching code frequency for ${repo.name}: ${error.message}`);
        return [];
    }
}

// -------------------- GENERATE HTML --------------------
async function buildHTMLReport(report) {
    const repoCharts = report.map((r, idx) => {
        const weeklyCommits = r.weeklyCommits || [];
        const weeklyCodeChanges = r.weeklyCodeChanges || [];
        
        // Get all unique weeks from both datasets
        const allWeeks = new Set();
        weeklyCommits.forEach(w => allWeeks.add(w.week));
        weeklyCodeChanges.forEach(w => allWeeks.add(w.week));
        
        // Convert to sorted array
        const weeks = Array.from(allWeeks).sort();
        
        // If no data at all, create empty arrays
        if (weeks.length === 0) {
            return `
    <div style="margin: 40px 0; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #0366d6;">${r.repo}</h2>
        <p style="color: #586069;">No data available for the last year.</p>
    </div>`;
        }
        
        const commitCounts = weeks.map(week => {
            const found = weeklyCommits.find(w => w.week === week);
            return found ? found.count : 0;
        });
        
        const additions = weeks.map(week => {
            const found = weeklyCodeChanges.find(w => w.week === week);
            return found ? found.additions : 0;
        });
        
        const deletions = weeks.map(week => {
            const found = weeklyCodeChanges.find(w => w.week === week);
            return found ? found.deletions : 0;
        });
        
        // Format week labels (show month/day)
        const weekLabels = weeks.map(week => {
            const date = new Date(week);
            return `${date.getMonth() + 1}/${date.getDate()}`;
        });
        
        return `
    <div style="margin: 40px 0; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #0366d6;">${r.repo}</h2>
        
        <div style="margin: 20px 0;">
            <h3>Commits per Week (Last Year)</h3>
            <canvas id="commitsChart_${idx}" style="max-height: 300px;"></canvas>
        </div>
        
        <div style="margin: 20px 0;">
            <h3>Code Changes per Week (Last Year)</h3>
            <canvas id="codeChart_${idx}" style="max-height: 300px;"></canvas>
        </div>
        
        <script>
            (function() {
                const weeks_${idx} = ${JSON.stringify(weekLabels)};
                const commits_${idx} = ${JSON.stringify(commitCounts)};
                const additions_${idx} = ${JSON.stringify(additions)};
                const deletions_${idx} = ${JSON.stringify(deletions)};
                
                new Chart(document.getElementById('commitsChart_${idx}'), {
                    type: 'line',
                    data: {
                        labels: weeks_${idx},
                        datasets: [{
                            label: 'Commits',
                            data: commits_${idx},
                            borderColor: 'rgb(75, 192, 192)',
                            backgroundColor: 'rgba(75, 192, 192, 0.2)',
                            tension: 0.1
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        scales: {
                            y: {
                                beginAtZero: true
                            }
                        }
                    }
                });
                
                new Chart(document.getElementById('codeChart_${idx}'), {
                    type: 'line',
                    data: {
                        labels: weeks_${idx},
                        datasets: [
                            {
                                label: 'Additions',
                                data: additions_${idx},
                                borderColor: 'rgb(75, 192, 192)',
                                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                                tension: 0.1
                            },
                            {
                                label: 'Deletions',
                                data: deletions_${idx},
                                borderColor: 'rgb(255, 99, 132)',
                                backgroundColor: 'rgba(255, 99, 132, 0.2)',
                                tension: 0.1
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        scales: {
                            y: {
                                beginAtZero: true
                            }
                        }
                    }
                });
            })();
        </script>
    </div>`;
    }).join('\n');
    
    return `
<!DOCTYPE html>
<html>
<head>
    <title>GitHub Org Report</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body {
            padding: 20px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            max-width: 1400px;
            margin: 0 auto;
        }
        h1 {
            color: #24292e;
            border-bottom: 2px solid #e1e4e8;
            padding-bottom: 10px;
        }
        h2 {
            color: #0366d6;
            margin-top: 30px;
        }
        h3 {
            color: #586069;
            font-size: 18px;
        }
    </style>
</head>
<body>
    <h1>GitHub Organization Report – ${ORG}</h1>

    <h2>Overview: Commits per Repository</h2>
    <canvas id="commitsChart" style="max-height: 400px;"></canvas>

    <h2>Overview: Code Additions vs Deletions</h2>
    <canvas id="codeChart" style="max-height: 400px;"></canvas>

    <h2>Per-Repository Weekly Analysis (Last Year)</h2>
    ${repoCharts}

    <script>
        const report = ${JSON.stringify(report)};

        new Chart(document.getElementById('commitsChart'), {
            type: 'bar',
            data: {
                labels: report.map(r => r.repo),
                datasets: [{
                    label: 'Total Commits',
                    data: report.map(r => r.commits),
                    backgroundColor: 'rgba(75, 192, 192, 0.6)'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });

        new Chart(document.getElementById('codeChart'), {
            type: 'bar',
            data: {
                labels: report.map(r => r.repo),
                datasets: [
                    {
                        label: 'Additions',
                        data: report.map(r => r.additions),
                        backgroundColor: 'rgba(75, 192, 192, 0.6)'
                    },
                    {
                        label: 'Deletions',
                        data: report.map(r => r.deletions),
                        backgroundColor: 'rgba(255, 99, 132, 0.6)'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
    </script>
</body>
</html>
`;
}

// -------------------- GET ORGANIZATION MEMBERS --------------------
async function getOrgMembers() {
    try {
        const members = [];
        let page = 1;
        let hasMore = true;
        
        while (hasMore && page <= 10) {
            const res = await fetch(`https://api.github.com/orgs/${ORG}/members?per_page=100&page=${page}`, {
                headers: { Authorization: `Bearer ${TOKEN}` }
            });
            
            if (!res.ok) {
                console.warn(`⚠️  Could not fetch members: HTTP ${res.status}`);
                break;
            }
            
            const pageMembers = await res.json();
            if (!Array.isArray(pageMembers) || pageMembers.length === 0) {
                hasMore = false;
                break;
            }
            
            members.push(...pageMembers.map(m => ({
                login: m.login,
                id: m.id,
                avatar_url: m.avatar_url
            })));
            
            const link = res.headers.get("link");
            hasMore = link && link.includes('rel="next"');
            page++;
        }
        
        return members;
    } catch (error) {
        console.warn(`⚠️  Error fetching organization members: ${error.message}`);
        return [];
    }
}

// -------------------- GET ALL COMMITS ACROSS ORG (FOR CONTRIBUTION CALENDAR) --------------------
async function getAllOrgCommits(repos) {
    try {
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        const since = oneYearAgo.toISOString();
        
        const allCommits = [];
        
        for (const repo of repos) {
            try {
                let page = 1;
                let hasMore = true;
                
                while (hasMore && page <= 5) { // Limit pages per repo
                    const res = await fetch(
                        `https://api.github.com/repos/${ORG}/${repo.name}/commits?per_page=100&page=${page}&since=${since}`,
                        { headers: { Authorization: `Bearer ${TOKEN}` } }
                    );
                    
                    if (!res.ok) break;
                    
                    const commits = await res.json();
                    if (!Array.isArray(commits) || commits.length === 0) {
                        hasMore = false;
                        break;
                    }
                    
                    allCommits.push(...commits.map(c => ({
                        date: c.commit.author.date,
                        author: c.commit.author.name,
                        login: c.author?.login || null,
                        repo: repo.name,
                        message: c.commit.message.substring(0, 50)
                    })));
                    
                    const link = res.headers.get("link");
                    hasMore = link && link.includes('rel="next"');
                    page++;
                }
            } catch (error) {
                console.warn(`⚠️  Error fetching commits for ${repo.name}: ${error.message}`);
            }
        }
        
        return allCommits;
    } catch (error) {
        console.warn(`⚠️  Error fetching all commits: ${error.message}`);
        return [];
    }
}

// -------------------- GET PRs AND ISSUES --------------------
async function getOrgPRsAndIssues(repos) {
    try {
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        const since = oneYearAgo.toISOString();
        
        const prs = [];
        const issues = [];
        
        for (const repo of repos) {
            try {
                // Get PRs
                const prRes = await fetch(
                    `https://api.github.com/repos/${ORG}/${repo.name}/pulls?state=all&per_page=100&since=${since}`,
                    { headers: { Authorization: `Bearer ${TOKEN}` } }
                );
                
                if (prRes.ok) {
                    const repoPRs = await prRes.json();
                    prs.push(...repoPRs.map(pr => ({
                        date: pr.created_at,
                        author: pr.user?.login || 'unknown',
                        repo: repo.name,
                        state: pr.state,
                        title: pr.title.substring(0, 50)
                    })));
                }
                
                // Get Issues
                const issueRes = await fetch(
                    `https://api.github.com/repos/${ORG}/${repo.name}/issues?state=all&per_page=100&since=${since}`,
                    { headers: { Authorization: `Bearer ${TOKEN}` } }
                );
                
                if (issueRes.ok) {
                    const repoIssues = await issueRes.json();
                    // Filter out PRs (issues API returns PRs too)
                    issues.push(...repoIssues
                        .filter(issue => !issue.pull_request)
                        .map(issue => ({
                            date: issue.created_at,
                            author: issue.user?.login || 'unknown',
                            repo: repo.name,
                            state: issue.state,
                            title: issue.title.substring(0, 50)
                        })));
                }
            } catch (error) {
                console.warn(`⚠️  Error fetching PRs/issues for ${repo.name}: ${error.message}`);
            }
        }
        
        return { prs, issues };
    } catch (error) {
        console.warn(`⚠️  Error fetching PRs and issues: ${error.message}`);
        return { prs: [], issues: [] };
    }
}

// -------------------- CREATE CONTRIBUTION CALENDAR DATA --------------------
function createContributionCalendar(commits, prs, issues) {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    oneYearAgo.setHours(0, 0, 0, 0);
    
    const calendar = new Map();
    
    // Initialize all days in the last year
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    for (let d = new Date(oneYearAgo); d <= today; d.setDate(d.getDate() + 1)) {
        const dateKey = d.toISOString().split('T')[0];
        calendar.set(dateKey, { date: dateKey, count: 0, level: 0 });
    }
    
    // Count commits
    commits.forEach(commit => {
        const date = new Date(commit.date).toISOString().split('T')[0];
        if (calendar.has(date)) {
            calendar.get(date).count++;
        }
    });
    
    // Count PRs (each PR = 2 contributions)
    prs.forEach(pr => {
        const date = new Date(pr.date).toISOString().split('T')[0];
        if (calendar.has(date)) {
            calendar.get(date).count += 2;
        }
    });
    
    // Count issues (each issue = 1 contribution)
    issues.forEach(issue => {
        const date = new Date(issue.date).toISOString().split('T')[0];
        if (calendar.has(date)) {
            calendar.get(date).count++;
        }
    });
    
    // Calculate levels (0-4) based on contribution count
    const counts = Array.from(calendar.values()).map(d => d.count);
    const maxCount = Math.max(...counts, 1);
    
    calendar.forEach((day, date) => {
        if (day.count === 0) {
            day.level = 0;
        } else if (day.count <= maxCount * 0.25) {
            day.level = 1;
        } else if (day.count <= maxCount * 0.5) {
            day.level = 2;
        } else if (day.count <= maxCount * 0.75) {
            day.level = 3;
        } else {
            day.level = 4;
        }
    });
    
    return Array.from(calendar.values());
}

// -------------------- GENERATE CONTRIBUTION REPORT HTML --------------------
async function buildContributionReport(contributionData) {
    const { members, commits, prs, issues, calendar, stats } = contributionData;
    
    // Group contributions by all contributors (including outside contributors)
    const memberContributions = new Map();
    const memberMap = new Map();
    
    // Initialize with org members
    members.forEach(m => {
        memberMap.set(m.login, m.avatar_url);
        memberContributions.set(m.login, {
            login: m.login,
            avatar: m.avatar_url,
            commits: 0,
            prs: 0,
            issues: 0,
            total: 0
        });
    });
    
    // Add contributors from commits (including outside contributors)
    commits.forEach(c => {
        if (c.login) {
            if (!memberContributions.has(c.login)) {
                // Outside contributor - use GitHub identicon as fallback
                memberContributions.set(c.login, {
                    login: c.login,
                    avatar: `https://github.com/identicons/${c.login}.png`,
                    commits: 0,
                    prs: 0,
                    issues: 0,
                    total: 0
                });
            }
            memberContributions.get(c.login).commits++;
            memberContributions.get(c.login).total++;
        }
    });
    
    // Add contributors from PRs (including outside contributors)
    prs.forEach(pr => {
        if (pr.author) {
            if (!memberContributions.has(pr.author)) {
                memberContributions.set(pr.author, {
                    login: pr.author,
                    avatar: `https://github.com/identicons/${pr.author}.png`,
                    commits: 0,
                    prs: 0,
                    issues: 0,
                    total: 0
                });
            }
            memberContributions.get(pr.author).prs++;
            memberContributions.get(pr.author).total += 2;
        }
    });
    
    // Add contributors from issues (including outside contributors)
    issues.forEach(issue => {
        if (issue.author) {
            if (!memberContributions.has(issue.author)) {
                memberContributions.set(issue.author, {
                    login: issue.author,
                    avatar: `https://github.com/identicons/${issue.author}.png`,
                    commits: 0,
                    prs: 0,
                    issues: 0,
                    total: 0
                });
            }
            memberContributions.get(issue.author).issues++;
            memberContributions.get(issue.author).total++;
        }
    });
    
    // Get top contributors first
    const topContributors = Array.from(memberContributions.values())
        .sort((a, b) => b.total - a.total)
        .slice(0, 20);
    
    // Try to get avatars for top outside contributors only (to avoid too many API calls)
    for (const contrib of topContributors) {
        if (!members.find(m => m.login === contrib.login) && contrib.avatar.includes('identicons')) {
            // Try to fetch avatar from GitHub API
            try {
                const res = await fetch(`https://api.github.com/users/${contrib.login}`, {
                    headers: { Authorization: `Bearer ${TOKEN}` }
                });
                if (res.ok) {
                    const user = await res.json();
                    contrib.avatar = user.avatar_url || contrib.avatar;
                }
            } catch (e) {
                // Keep identicon if fetch fails
            }
        }
    }
    
    // Generate calendar HTML
    const calendarHTML = generateCalendarHTML(calendar);
    
    return `
<!DOCTYPE html>
<html>
<head>
    <title>Organization Contribution Report - ${ORG}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body {
            padding: 20px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            max-width: 1400px;
            margin: 0 auto;
            background: #f6f8fa;
        }
        h1 {
            color: #24292e;
            border-bottom: 2px solid #e1e4e8;
            padding-bottom: 10px;
        }
        h2 {
            color: #0366d6;
            margin-top: 30px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin: 20px 0;
        }
        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            text-align: center;
        }
        .stat-value {
            font-size: 36px;
            font-weight: bold;
            color: #0366d6;
        }
        .stat-label {
            color: #586069;
            margin-top: 8px;
        }
        .contribution-calendar {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            margin: 20px 0;
        }
        .calendar-wrapper {
            display: flex;
            gap: 10px;
            margin-top: 10px;
        }
        .calendar-labels-y {
            display: flex;
            flex-direction: column;
            gap: 3px;
            padding-top: 15px;
        }
        .calendar-label-y {
            height: 11px;
            font-size: 11px;
            color: #586069;
            text-align: right;
            padding-right: 5px;
        }
        .calendar-content {
            flex: 1;
        }
        .calendar-labels-x {
            display: grid;
            grid-template-columns: repeat(53, 1fr);
            gap: 3px;
            margin-top: 5px;
            padding-left: 30px;
        }
        .calendar-label-x {
            font-size: 11px;
            color: #586069;
            text-align: center;
        }
        .calendar-grid {
            display: grid;
            grid-template-columns: repeat(53, 1fr);
            gap: 3px;
        }
        .calendar-day {
            width: 11px;
            height: 11px;
            border-radius: 2px;
            cursor: pointer;
        }
        .calendar-day[data-level="0"] { background: #ebedf0; }
        .calendar-day[data-level="1"] { background: #9be9a8; }
        .calendar-day[data-level="2"] { background: #40c463; }
        .calendar-day[data-level="3"] { background: #30a14e; }
        .calendar-day[data-level="4"] { background: #216e39; }
        .calendar-day:hover { border: 1px solid #000; }
        .calendar-legend {
            display: flex;
            align-items: center;
            gap: 5px;
            margin-top: 15px;
            font-size: 12px;
            color: #586069;
        }
        .contributors-list {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 15px;
            margin: 20px 0;
        }
        .contributor-card {
            background: white;
            padding: 15px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            display: flex;
            align-items: center;
            gap: 15px;
        }
        .contributor-avatar {
            width: 48px;
            height: 48px;
            border-radius: 50%;
        }
        .contributor-info {
            flex: 1;
        }
        .contributor-name {
            font-weight: 600;
            color: #24292e;
        }
        .contributor-stats {
            font-size: 12px;
            color: #586069;
            margin-top: 4px;
        }
        .chart-container {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            margin: 20px 0;
        }
    </style>
</head>
<body>
    <h1>🏢 Organization Contribution Report – ${ORG}</h1>
    
    <div class="stats-grid">
        <div class="stat-card">
            <div class="stat-value">${stats.totalCommits}</div>
            <div class="stat-label">Total Commits</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${stats.totalPRs}</div>
            <div class="stat-label">Pull Requests</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${stats.totalContributions}</div>
            <div class="stat-label">Total Contributions</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${stats.totalRepos}</div>
            <div class="stat-label">Total Repositories</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${members.length}</div>
            <div class="stat-label">Members</div>
        </div>
    </div>
    
    <h2>Contribution Calendar (Last Year)</h2>
    <div class="contribution-calendar">
        ${calendarHTML}
    </div>
    
    <h2>Top Contributors</h2>
    <div class="contributors-list">
        ${topContributors.map(c => `
            <div class="contributor-card">
                <img src="${c.avatar}" alt="${c.login}" class="contributor-avatar" onerror="this.src='https://github.com/identicons/${c.login}.png'">
                <div class="contributor-info">
                    <div class="contributor-name">${c.login}</div>
                    <div class="contributor-stats">
                        ${c.commits} commits • ${c.prs} PRs • ${c.issues} issues
                    </div>
                </div>
            </div>
        `).join('')}
    </div>
    
    <h2>Contributions Over Time</h2>
    <div class="chart-container">
        <canvas id="contributionsChart"></canvas>
    </div>
    
    <script>
        const calendarData = ${JSON.stringify(calendar)};
        
        // Group by month for the chart
        const monthlyData = {};
        calendarData.forEach(day => {
            const date = new Date(day.date);
            const monthKey = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
            if (!monthlyData[monthKey]) {
                monthlyData[monthKey] = 0;
            }
            monthlyData[monthKey] += day.count;
        });
        
        const months = Object.keys(monthlyData).sort();
        const contributions = months.map(m => monthlyData[m]);
        
        new Chart(document.getElementById('contributionsChart'), {
            type: 'line',
            data: {
                labels: months.map(m => {
                    const [year, month] = m.split('-');
                    return new Date(year, month - 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                }),
                datasets: [{
                    label: 'Contributions',
                    data: contributions,
                    borderColor: 'rgb(75, 192, 192)',
                    backgroundColor: 'rgba(75, 192, 192, 0.2)',
                    tension: 0.1,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
    </script>
</body>
</html>
`;
}

// -------------------- GENERATE CALENDAR HTML --------------------
function generateCalendarHTML(calendar) {
    // Group by weeks (53 weeks in a year)
    const weeks = [];
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    
    // Get first Monday
    const firstMonday = new Date(oneYearAgo);
    const day = firstMonday.getDay();
    const diff = firstMonday.getDate() - day + (day === 0 ? -6 : 1);
    firstMonday.setDate(diff);
    firstMonday.setHours(0, 0, 0, 0);
    
    // Day labels (Sun, Mon, Tue, etc.)
    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    for (let w = 0; w < 53; w++) {
        const week = [];
        for (let d = 0; d < 7; d++) {
            const date = new Date(firstMonday);
            date.setDate(date.getDate() + (w * 7) + d);
            const dateKey = date.toISOString().split('T')[0];
            const dayData = calendar.find(c => c.date === dateKey);
            week.push(dayData || { date: dateKey, count: 0, level: 0 });
        }
        weeks.push(week);
    }
    
    // Generate month labels for X axis
    const monthLabels = [];
    let lastMonth = -1;
    for (let w = 0; w < 53; w++) {
        const date = new Date(firstMonday);
        date.setDate(date.getDate() + (w * 7));
        const month = date.getMonth();
        if (month !== lastMonth) {
            monthLabels[w] = date.toLocaleDateString('en-US', { month: 'short' });
            lastMonth = month;
        } else {
            monthLabels[w] = '';
        }
    }
    
    // Build calendar HTML with labels
    let html = '<div class="calendar-wrapper">';
    
    // Y-axis labels (days of week) - show only Mon, Wed, Fri to save space
    html += '<div class="calendar-labels-y">';
    for (let d = 0; d < 7; d++) {
        // Show only Monday (1), Wednesday (3), Friday (5)
        const label = (d === 1 || d === 3 || d === 5) ? dayLabels[d] : '';
        html += `<div class="calendar-label-y">${label}</div>`;
    }
    html += '</div>';
    
    // Calendar grid
    html += '<div class="calendar-content">';
    html += '<div class="calendar-grid">';
    
    for (let w = 0; w < 53; w++) {
        for (let d = 0; d < 7; d++) {
            const day = weeks[w][d];
            const date = new Date(day.date);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            if (date <= today) {
                html += `<div class="calendar-day" data-level="${day.level}" title="${day.date}: ${day.count} contributions"></div>`;
            } else {
                html += `<div style="width: 11px; height: 11px;"></div>`;
            }
        }
    }
    
    html += '</div>'; // calendar-grid
    
    // X-axis labels (months)
    html += '<div class="calendar-labels-x">';
    monthLabels.forEach(label => {
        html += `<div class="calendar-label-x">${label}</div>`;
    });
    html += '</div>';
    
    html += '</div>'; // calendar-content
    html += '</div>'; // calendar-wrapper
    
    html += `
        <div class="calendar-legend">
            <span>Less</span>
            <div class="calendar-day" data-level="0"></div>
            <div class="calendar-day" data-level="1"></div>
            <div class="calendar-day" data-level="2"></div>
            <div class="calendar-day" data-level="3"></div>
            <div class="calendar-day" data-level="4"></div>
            <span>More</span>
        </div>
    `;
    
    return html;
}

// -------------------- GENERATE PDF --------------------
async function generatePDF(report) {
    const pdfDoc = await PDFDocument.create();

    const page = pdfDoc.addPage([800, 1000]);
    const { width } = page.getSize();

    let y = 960;

    page.drawText(`GitHub Org Report – ${ORG}`, { x: 50, y, size: 22 });
    y -= 40;

    report.forEach(r => {
        page.drawText(`${r.repo}  |  Commits: ${r.commits} | +${r.additions} / -${r.deletions}`, {
            x: 50,
            y,
            size: 14
        });
        y -= 22;
    });

    const pdfBytes = await pdfDoc.save();
    await fs.writeFile("report.pdf", pdfBytes);

    console.log("📄 PDF Generated: report.pdf");
}

// -------------------- GET REPO COMMITS FOR CONTRIBUTION REPORT --------------------
async function getRepoCommitsForContribution(repo) {
    try {
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        const since = oneYearAgo.toISOString();
        
        const commits = [];
        let page = 1;
        let hasMore = true;
        
        while (hasMore && page <= 20) { // Limit to 20 pages per repo
            const res = await fetch(
                `https://api.github.com/repos/${ORG}/${repo.name}/commits?per_page=100&page=${page}&since=${since}`,
                { headers: { Authorization: `Bearer ${TOKEN}` } }
            );
            
            if (!res.ok) break;
            
            const pageCommits = await res.json();
            if (!Array.isArray(pageCommits) || pageCommits.length === 0) {
                hasMore = false;
                break;
            }
            
            commits.push(...pageCommits.map(c => ({
                date: c.commit.author.date,
                author: c.commit.author.name,
                login: c.author?.login || null,
                message: c.commit.message.substring(0, 50)
            })));
            
            const link = res.headers.get("link");
            hasMore = link && link.includes('rel="next"');
            page++;
        }
        
        return commits;
    } catch (error) {
        console.warn(`⚠️  Error fetching commits for ${repo.name}: ${error.message}`);
        return [];
    }
}

// -------------------- GET REPO PRs AND ISSUES FOR CONTRIBUTION REPORT --------------------
async function getRepoPRsAndIssues(repo) {
    try {
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        const since = oneYearAgo.toISOString();
        
        const prs = [];
        const issues = [];
        
        // Get PRs
        try {
            const prRes = await fetch(
                `https://api.github.com/repos/${ORG}/${repo.name}/pulls?state=all&per_page=100&since=${since}`,
                { headers: { Authorization: `Bearer ${TOKEN}` } }
            );
            
            if (prRes.ok) {
                const repoPRs = await prRes.json();
                prs.push(...repoPRs.map(pr => ({
                    date: pr.created_at,
                    author: pr.user?.login || 'unknown',
                    state: pr.state,
                    title: pr.title.substring(0, 50)
                })));
            }
        } catch (e) {
            // Ignore PR fetch errors
        }
        
        // Get Issues
        try {
            const issueRes = await fetch(
                `https://api.github.com/repos/${ORG}/${repo.name}/issues?state=all&per_page=100&since=${since}`,
                { headers: { Authorization: `Bearer ${TOKEN}` } }
            );
            
            if (issueRes.ok) {
                const repoIssues = await issueRes.json();
                issues.push(...repoIssues
                    .filter(issue => !issue.pull_request)
                    .map(issue => ({
                        date: issue.created_at,
                        author: issue.user?.login || 'unknown',
                        state: issue.state,
                        title: issue.title.substring(0, 50)
                    })));
            }
        } catch (e) {
            // Ignore issue fetch errors
        }
        
        return { prs, issues };
    } catch (error) {
        console.warn(`⚠️  Error fetching PRs/issues for ${repo.name}: ${error.message}`);
        return { prs: [], issues: [] };
    }
}

// -------------------- GENERATE PER-REPO CONTRIBUTION REPORT --------------------
async function generateRepoContributionReport(repo, commits, prs, issues) {
    const calendar = createContributionCalendar(commits, prs, issues);
    
    // Group contributions by contributor
    const contributorMap = new Map();
    
    commits.forEach(c => {
        if (c.login) {
            if (!contributorMap.has(c.login)) {
                contributorMap.set(c.login, {
                    login: c.login,
                    avatar: `https://github.com/identicons/${c.login}.png`,
                    commits: 0,
                    prs: 0,
                    issues: 0,
                    total: 0
                });
            }
            contributorMap.get(c.login).commits++;
            contributorMap.get(c.login).total++;
        }
    });
    
    prs.forEach(pr => {
        if (pr.author) {
            if (!contributorMap.has(pr.author)) {
                contributorMap.set(pr.author, {
                    login: pr.author,
                    avatar: `https://github.com/identicons/${pr.author}.png`,
                    commits: 0,
                    prs: 0,
                    issues: 0,
                    total: 0
                });
            }
            contributorMap.get(pr.author).prs++;
            contributorMap.get(pr.author).total += 2;
        }
    });
    
    issues.forEach(issue => {
        if (issue.author) {
            if (!contributorMap.has(issue.author)) {
                contributorMap.set(issue.author, {
                    login: issue.author,
                    avatar: `https://github.com/identicons/${issue.author}.png`,
                    commits: 0,
                    prs: 0,
                    issues: 0,
                    total: 0
                });
            }
            contributorMap.get(issue.author).issues++;
            contributorMap.get(issue.author).total++;
        }
    });
    
    // Try to get avatars for top contributors
    const topContributors = Array.from(contributorMap.values())
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);
    
    for (const contrib of topContributors) {
        try {
            const res = await fetch(`https://api.github.com/users/${contrib.login}`, {
                headers: { Authorization: `Bearer ${TOKEN}` }
            });
            if (res.ok) {
                const user = await res.json();
                contrib.avatar = user.avatar_url || contrib.avatar;
            }
        } catch (e) {
            // Keep identicon if fetch fails
        }
    }
    
    const stats = {
        totalCommits: commits.length,
        totalPRs: prs.length,
        totalIssues: issues.length,
        totalContributions: commits.length + (prs.length * 2) + issues.length,
        totalContributors: contributorMap.size
    };
    
    const calendarHTML = generateCalendarHTML(calendar);
    
    // Group by month for the chart
    const monthlyData = {};
    calendar.forEach(day => {
        const date = new Date(day.date);
        const monthKey = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
        if (!monthlyData[monthKey]) {
            monthlyData[monthKey] = 0;
        }
        monthlyData[monthKey] += day.count;
    });
    
    const months = Object.keys(monthlyData).sort();
    const contributions = months.map(m => monthlyData[m]);
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>${repo.name} - Contribution Report</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body {
            padding: 20px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            max-width: 1400px;
            margin: 0 auto;
            background: #f6f8fa;
        }
        h1 {
            color: #24292e;
            border-bottom: 2px solid #e1e4e8;
            padding-bottom: 10px;
        }
        h2 {
            color: #0366d6;
            margin-top: 30px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin: 20px 0;
        }
        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            text-align: center;
        }
        .stat-value {
            font-size: 36px;
            font-weight: bold;
            color: #0366d6;
        }
        .stat-label {
            color: #586069;
            margin-top: 8px;
        }
        .contribution-calendar {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            margin: 20px 0;
        }
        .calendar-wrapper {
            display: flex;
            gap: 10px;
            margin-top: 10px;
        }
        .calendar-labels-y {
            display: flex;
            flex-direction: column;
            gap: 3px;
            padding-top: 15px;
        }
        .calendar-label-y {
            height: 11px;
            font-size: 11px;
            color: #586069;
            text-align: right;
            padding-right: 5px;
        }
        .calendar-content {
            flex: 1;
        }
        .calendar-labels-x {
            display: grid;
            grid-template-columns: repeat(53, 1fr);
            gap: 3px;
            margin-top: 5px;
            padding-left: 30px;
        }
        .calendar-label-x {
            font-size: 11px;
            color: #586069;
            text-align: center;
        }
        .calendar-grid {
            display: grid;
            grid-template-columns: repeat(53, 1fr);
            gap: 3px;
        }
        .calendar-day {
            width: 11px;
            height: 11px;
            border-radius: 2px;
            cursor: pointer;
        }
        .calendar-day[data-level="0"] { background: #ebedf0; }
        .calendar-day[data-level="1"] { background: #9be9a8; }
        .calendar-day[data-level="2"] { background: #40c463; }
        .calendar-day[data-level="3"] { background: #30a14e; }
        .calendar-day[data-level="4"] { background: #216e39; }
        .calendar-day:hover { border: 1px solid #000; }
        .calendar-legend {
            display: flex;
            align-items: center;
            gap: 5px;
            margin-top: 15px;
            font-size: 12px;
            color: #586069;
        }
        .contributors-list {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 15px;
            margin: 20px 0;
        }
        .contributor-card {
            background: white;
            padding: 15px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            display: flex;
            align-items: center;
            gap: 15px;
        }
        .contributor-avatar {
            width: 48px;
            height: 48px;
            border-radius: 50%;
        }
        .contributor-info {
            flex: 1;
        }
        .contributor-name {
            font-weight: 600;
            color: #24292e;
        }
        .contributor-stats {
            font-size: 12px;
            color: #586069;
            margin-top: 4px;
        }
        .chart-container {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            margin: 20px 0;
        }
    </style>
</head>
<body>
    <h1>📦 ${repo.name} - Contribution Report</h1>
    
    <div class="stats-grid">
        <div class="stat-card">
            <div class="stat-value">${stats.totalCommits}</div>
            <div class="stat-label">Total Commits</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${stats.totalPRs}</div>
            <div class="stat-label">Pull Requests</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${stats.totalContributions}</div>
            <div class="stat-label">Total Contributions</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${stats.totalContributors}</div>
            <div class="stat-label">Contributors</div>
        </div>
    </div>
    
    <h2>Contribution Calendar (Last Year)</h2>
    <div class="contribution-calendar">
        ${calendarHTML}
    </div>
    
    <h2>Top Contributors</h2>
    <div class="contributors-list">
        ${topContributors.map(c => `
            <div class="contributor-card">
                <img src="${c.avatar}" alt="${c.login}" class="contributor-avatar" onerror="this.src='https://github.com/identicons/${c.login}.png'">
                <div class="contributor-info">
                    <div class="contributor-name">${c.login}</div>
                    <div class="contributor-stats">
                        ${c.commits} commits • ${c.prs} PRs • ${c.issues} issues
                    </div>
                </div>
            </div>
        `).join('')}
    </div>
    
    <h2>Contributions Over Time</h2>
    <div class="chart-container">
        <canvas id="contributionsChart"></canvas>
    </div>
    
    <script>
        new Chart(document.getElementById('contributionsChart'), {
            type: 'line',
            data: {
                labels: ${JSON.stringify(months.map(m => {
                    const [year, month] = m.split('-');
                    return new Date(year, month - 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                }))},
                datasets: [{
                    label: 'Contributions',
                    data: ${JSON.stringify(contributions)},
                    borderColor: 'rgb(75, 192, 192)',
                    backgroundColor: 'rgba(75, 192, 192, 0.2)',
                    tension: 0.1,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Contributions'
                        }
                    },
                    x: {
                        title: {
                            display: true,
                            text: 'Month'
                        }
                    }
                }
            }
        });
    </script>
</body>
</html>
`;
    
    // Create reports directory if it doesn't exist
    const reportsDir = 'repo-contribution-reports';
    await fs.ensureDir(reportsDir);
    
    // Save HTML file (sanitize repo name for filename)
    const safeRepoName = repo.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const filePath = `${reportsDir}/${safeRepoName}-contribution.html`;
    await fs.writeFile(filePath, html);
    
    return filePath;
}

// -------------------- MAIN SCRIPT --------------------
async function run() {
    console.log("🔍 Fetching repositories...");
    const repos = await getRepos();

    const report = [];

    for (const repo of repos) {
        console.log(`📦 Processing ${repo.name}...`);

        const commits = await getCommitCount(repo);
        const codeFreq = await getCodeFrequency(repo);
        const commitsWithDates = await getCommitsWithDates(repo);

        // Ensure codeFreq is an array before calling reduce
        const additions = Array.isArray(codeFreq) 
            ? codeFreq.reduce((s, w) => s + (w[1] || 0), 0) 
            : 0;
        const deletions = Array.isArray(codeFreq) 
            ? codeFreq.reduce((s, w) => s + (w[2] || 0), 0) 
            : 0;

        // Process weekly data
        const weeklyCommits = groupCommitsByWeek(commitsWithDates);
        const weeklyCodeChanges = Array.isArray(codeFreq) && codeFreq.length > 0
            ? groupCodeFrequencyByWeek(codeFreq)
            : [];

        report.push({
            repo: repo.name,
            commits,
            additions,
            deletions,
            weeklyCommits,
            weeklyCodeChanges
        });
    }

    fs.writeJsonSync("github-report.json", report, { spaces: 2 });
    console.log("📁 JSON Saved: github-report.json");

    const html = await buildHTMLReport(report);
    fs.writeFileSync("report.html", html);
    console.log("📊 HTML Report Generated: report.html");

    await generatePDF(report);
    
    // Generate Organization Contribution Report
    console.log("\n🏢 Generating Organization Contribution Report...");
    await generateContributionReport(repos);
    
    // Generate Per-Repository Contribution Reports
    console.log("\n📦 Generating Per-Repository Contribution Reports...");
    await fs.ensureDir('repo-contribution-reports');
    
    for (const repo of repos) {
        console.log(`   📊 Generating contribution report for ${repo.name}...`);
        try {
            const commits = await getRepoCommitsForContribution(repo);
            const { prs, issues } = await getRepoPRsAndIssues(repo);
            
            const filePath = await generateRepoContributionReport(repo, commits, prs, issues);
            console.log(`      ✅ Generated: ${filePath}`);
        } catch (error) {
            console.warn(`      ⚠️  Error generating report for ${repo.name}: ${error.message}`);
        }
    }
    
    console.log("\n✅ All reports generated successfully!");
}

// -------------------- GENERATE CONTRIBUTION REPORT --------------------
async function generateContributionReport(repos) {
    console.log("👥 Fetching organization members...");
    const members = await getOrgMembers();
    console.log(`   Found ${members.length} members`);
    
    console.log("📝 Fetching all commits across organization...");
    const commits = await getAllOrgCommits(repos);
    console.log(`   Found ${commits.length} commits`);
    
    console.log("🔍 Fetching PRs and issues...");
    const { prs, issues } = await getOrgPRsAndIssues(repos);
    console.log(`   Found ${prs.length} PRs and ${issues.length} issues`);
    
    console.log("📅 Creating contribution calendar...");
    const calendar = createContributionCalendar(commits, prs, issues);
    
    const stats = {
        totalCommits: commits.length,
        totalPRs: prs.length,
        totalIssues: issues.length,
        totalContributions: commits.length + (prs.length * 2) + issues.length,
        totalRepos: repos.length
    };
    
    const contributionData = {
        members,
        commits,
        prs,
        issues,
        calendar,
        stats
    };
    
    fs.writeJsonSync("contribution-report.json", contributionData, { spaces: 2 });
    console.log("📁 JSON Saved: contribution-report.json");
    
    const contributionHTML = await buildContributionReport(contributionData);
    fs.writeFileSync("blockchainsuperheroes_contribution-report.html", contributionHTML);
    console.log("📊 Contribution Report Generated: blockchainsuperheroes_contribution-report.html");
}

run()
    .then(() => {
        console.log("🏁 report.js finished.");
        process.exit(0);
    })
    .catch((err) => {
        console.error("❌ report.js failed:", err);
        process.exit(1);
    });
