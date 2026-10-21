import fs from "fs/promises";
import path from "path";

const CENTRAL_REPO_NAME = "auto-projects";
const PROJECT_SCHEMA_FILE = "project-schema.json";
const CONFIG_FILE = "projects-config.json";
const PROJECTS_FILE = "projects.json";
const ICONS_DIR = "icons";
const GITHUB_API_BASE = "https://api.github.com";
const VERCEL_API_BASE = "https://api.vercel.com";
const PROJECTS_LIMIT = 100;

const GH_TOKEN = process.env.GH_PAT;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;

if (!GH_TOKEN || !VERCEL_TOKEN) {
  console.error(
    "Github Personal Access Token (GH_PAT) dan Vercel Token (VERCEL_TOKEN) tidak ada di Github Secrets!",
  );
  process.exit(1);
}

const ghHeaders = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: "application/vnd.github.v3+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const vercelHeaders = {
  Authorization: `Bearer ${VERCEL_TOKEN}`,
};

function formatProjectId(repoName, githubRepoId) {
  const cleanSlug = repoName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const shortId = Number(githubRepoId).toString(36);
  return (prefix = "prj") => `${prefix}-${cleanSlug}--${shortId}`;
}

async function loadJsonFile(filePath, defaultValue = []) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return defaultValue;
  }
}

async function getVercelReadyProjects() {
  const res = await fetch(
    `${VERCEL_API_BASE}/v10/projects?limit=${PROJECTS_LIMIT}`,
    {
      headers: vercelHeaders,
    },
  );
  if (!res.ok) throw new Error(`Gagal membaca API Vercel: ${res.statusText}`);
  let data = await res.json();
  let projects = data.projects || [];

  if (projects.length === 0) {
    const teamRes = await fetch(`${VERCEL_API_BASE}/v2/teams`, {
      headers: vercelHeaders,
    });
    const teamData = await teamRes.json();
    const firstTeamId = teamData?.teams?.[0]?.id;
    if (firstTeamId) {
      console.log(
        `Mendapatkan proyek dari tim Vercel dengan ID: ${firstTeamId}`,
      );
      const teamProjectsRes = await fetch(
        `${VERCEL_API_BASE}/v10/projects?limit=${PROJECTS_LIMIT}&teamId=${firstTeamId}`,
        {
          headers: vercelHeaders,
        },
      );
      if (!teamProjectsRes.ok) {
        throw new Error(
          `Gagal membaca proyek tim Vercel: ${teamProjectsRes.statusText}`,
        );
      }
      const retryData = await teamProjectsRes.json();
      projects = retryData.projects || [];
    }
  }

  const vercelMap = new Map();
  for (const proj of projects) {
    let repoFullName = proj.link?.repo;
    let repoName = proj.name;

    if (repoFullName) {
      const parts = repoFullName.split("/");
      repoName = parts[parts.length - 1];
    }

    const prodTarget = proj.targets?.production;
    if (prodTarget) {
      const hasAlias =
        Array.isArray(prodTarget.alias) && prodTarget.alias.length > 0;
      const domain = hasAlias ? prodTarget.alias[0] : prodTarget.url;
      const prodUrl = domain ? `https://${domain}` : null;

      const info = {
        vercelProjectId: proj.id,
        name: proj.name,
        url: prodUrl,
        state: prodTarget.readyState || prodTarget.state,
        framework: proj.framework,
        createdAt: proj.createdAt
          ? new Date(proj.createdAt).toISOString()
          : null,
        updatedAt: prodTarget.createdAt
          ? new Date(prodTarget.createdAt).toISOString()
          : null,
      };

      vercelMap.set(repoName.toLowerCase(), info);
      vercelMap.set(proj.name.toLowerCase(), info);
    }
  }
  return vercelMap;
}

async function getAllGithubRepos() {
  let page = 1;
  const repos = [];
  while (true) {
    const endpoint = `${GITHUB_API_BASE}/user/repos?per_page=${PROJECTS_LIMIT}&page=${page}&affiliation=owner&sort=updated`;
    const res = await fetch(endpoint, { headers: ghHeaders });

    if (!res.ok) throw new Error(`Gagal membaca API GitHub: ${res.statusText}`);
    const pageRepos = await res.json();
    if (pageRepos.length === 0) break;
    repos.push(...pageRepos);
    page++;
  }
  return repos;
}

async function getProjectSchema(owner, repoName) {
  const endpoint = `${GITHUB_API_BASE}/repos/${owner}/${repoName}/contents/${PROJECT_SCHEMA_FILE}`;
  const res = await fetch(endpoint, { headers: ghHeaders });

  if (res.status === 404 || !res.ok) return null;

  const data = await res.json();
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  try {
    return JSON.parse(content);
  } catch {
    console.warn(`Format JSON salah di ${repoName}/${PROJECT_SCHEMA_FILE}`);
    return null;
  }
}

async function copyProjectIcon(owner, repoName, projectId, iconPath) {
  if (!iconPath) return { localPath: null, rawUrl: "" };

  if (iconPath.startsWith("http://") || iconPath.startsWith("https://")) {
    return { localPath: null, rawUrl: iconPath };
  }

  const cleanPath = iconPath.replace(/^\/+/, "");
  const endpoint = `${GITHUB_API_BASE}/repos/${owner}/${repoName}/contents/${cleanPath}`;

  const res = await fetch(endpoint, {
    headers: { ...ghHeaders, Accept: "application/vnd.github.raw+json" },
  });

  if (!res.ok) {
    console.warn(
      `Gagal mengambil ikon proyek dari ${repoName}/${cleanPath}:${res.statusText}`,
    );
    return { localPath: null, rawUrl: "" };
  }

  const ext = path.extname(cleanPath) || ".png";
  const filename = `${projectId}${ext}`;
  const filePath = `${ICONS_DIR}/${filename}`;

  const arrayBuffer = await res.arrayBuffer();
  await fs.mkdir(ICONS_DIR, { recursive: true });
  await fs.writeFile(filePath, Buffer.from(arrayBuffer));

  const rawUrl = `https://raw.githubusercontent.com/${owner}/${CENTRAL_REPO_NAME}/main/${ICONS_DIR}/${filename}`;
  return { localPath: filename, rawUrl };
}

async function cleanupOrphanedIcons(activeIconFiles) {
  try {
    const files = await fs.readdir(ICONS_DIR);
    for (const file of files) {
      if (!activeIconFiles.has(file)) {
        await fs.unlink(path.join(ICONS_DIR, file));
        console.log(
          `Berhasil menghapus ikon lama: ${file} dari folder${ICONS_DIR}`,
        );
      }
    }
  } catch {
    console.warn(`Gagal untuk membersihkan ikon lama di folder ${ICONS_DIR}`);
  }
}

async function getRepoLanguages(owner, repoName) {
  const endpoint = `${GITHUB_API_BASE}/repos/${owner}/${repoName}/languages`;
  const res = await fetch(endpoint, { headers: ghHeaders });

  if (!res.ok) return [];

  const data = await res.json();
  const totalBytes = Object.values(data).reduce((sum, bytes) => sum + bytes, 0);

  if (totalBytes === 0) return [];

  return Object.entries(data).map(([language, bytes]) => ({
    language,
    percentage: Number(((bytes / totalBytes) * 100).toFixed(2)),
  }));
}

function getProjectStatus(schema, repo, vercelInfo) {
  if (schema.status) return schema.status;

  if (repo.archived) return "archived";
  if (repo.disabled) return "disabled";

  if (vercelInfo?.state) {
    const state = vercelInfo.state.toUpperCase();
    if (state === "ERROR" || state === "CANCELED") return "error";
    if (
      state === "BUILDING" ||
      state === "INITIALIZING" ||
      state === "QUEUED"
    ) {
      return "building";
    }
  }

  const lastUpdate = new Date(
    vercelInfo?.updatedAt || repo.pushed_at || repo.updated_at,
  );
  const diffDays = (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);

  if (diffDays > 180) return "maintenance";

  return "active";
}

async function main() {
  console.log("Membaca konfigurasi lokal dan cache proyek...");
  const existingConfig = await loadJsonFile(CONFIG_FILE, []);
  const existingProjects = await loadJsonFile(PROJECTS_FILE, []);

  const configMap = new Map(existingConfig.map((item) => [item.id, item]));
  const existingProjectMap = new Map(
    existingProjects.map((item) => [item.id, item]),
  );

  console.log("Sedang mengambil data proyek dari Vercel...");
  const vercelMap = await getVercelReadyProjects();

  console.log("Memindahkan data proyek dari GitHub...");
  const repos = await getAllGithubRepos();

  const finalProjects = [];
  const updatedConfig = [];
  const activeIconFiles = new Set();

  for (const repo of repos) {
    if (repo.name.toLowerCase() === CENTRAL_REPO_NAME.toLowerCase()) continue;

    const schema = await getProjectSchema(repo.owner.login, repo.name);
    if (!schema || schema.listed === false) continue;

    const targetRepoName = schema.repoName ?? repo.name;
    const makeId = formatProjectId(targetRepoName, repo.id);
    const repoId = schema.id ?? makeId("prj");
    const iconId = makeId("icn");

    const currentConfig =
      configMap.get(repoId) ||
      existingConfig.find(
        (item) => item.repoName?.toLowerCase() === targetRepoName.toLowerCase(),
      );
    const cachedProject = existingProjectMap.get(currentConfig?.id || repoId);

    const isListed = currentConfig?.listed ?? true;
    const checkPeriodically = currentConfig?.checkPeriodically ?? true;
    const pinned = schema.pinned ?? currentConfig?.pinned ?? false;

    const configData = {
      id: repoId,
      repoName: targetRepoName,
      listed: isListed,
      checkPeriodically,
      pinned,
      lastCheckedAt: new Date().toISOString(),
    };

    if (currentConfig && currentConfig.listed === false) {
      updatedConfig.push(currentConfig);
      continue;
    }

    if (
      currentConfig &&
      currentConfig.checkPeriodically === false &&
      cachedProject
    ) {
      updatedConfig.push(configData);
      finalProjects.push(cachedProject);
      if (cachedProject.icon && cachedProject.icon.includes(`/${ICONS_DIR}/`)) {
        activeIconFiles.add(path.basename(cachedProject.icon));
      }
      continue;
    }

    updatedConfig.push(configData);

    if (!isListed) continue;

    const vercelInfo =
      vercelMap.get(targetRepoName.toLowerCase()) ||
      vercelMap.get(repo.name.toLowerCase());

    const { localPath, rawUrl } = await copyProjectIcon(
      repo.owner.login,
      repo.name,
      iconId,
      schema.icon,
    );

    if (localPath) activeIconFiles.add(localPath);

    const finalStatus = getProjectStatus(schema, repo, vercelInfo);

    const fallbackUrl = `https://${targetRepoName.toLowerCase()}.vercel.app`;
    const finalUrl =
      schema.url ?? vercelInfo?.url ?? (repo.homepage || fallbackUrl);

    const finalCreatedAt =
      schema.createdAt ??
      vercelInfo?.createdAt ??
      repo.created_at ??
      new Date().toISOString();

    const finalUpdatedAt =
      schema.updatedAt ??
      schema.lastDeployedAt ??
      vercelInfo?.updatedAt ??
      repo.updated_at ??
      new Date().toISOString();

    const defaultStack = [
      ...(vercelInfo?.framework ? [vercelInfo.framework] : []),
      ...(repo.language ? [repo.language] : []),
      ...(Array.isArray(repo.topics) ? repo.topics : []),
    ];
    const uniqueDefaultStack = [...new Set(defaultStack.filter(Boolean))];

    const finalStack =
      Array.isArray(schema.stack) && schema.stack.length > 0
        ? schema.stack
        : uniqueDefaultStack;

    const languagePercentages = Array.isArray(schema.languagePercentages)
      ? schema.languagePercentages
      : await getRepoLanguages(repo.owner.login, repo.name);

    const isPublic =
      schema.public !== undefined ? schema.public : !repo.private;

    const finalGithubUrl =
      schema.githubUrl !== undefined
        ? schema.githubUrl
        : isPublic
          ? repo.html_url
          : null;

    finalProjects.push({
      id: repoId,
      status: finalStatus,
      repoName: targetRepoName,
      title: schema.title ?? vercelInfo?.name ?? targetRepoName,
      description: schema.description ?? repo.description ?? "",
      category: schema.category ?? "",
      tags: Array.isArray(schema.tags) ? schema.tags : [],
      pinned: pinned,
      stack: finalStack,
      languagePercentages,
      icon: rawUrl || schema.icon || "",
      url: finalUrl,
      githubUrl: finalGithubUrl,
      public: isPublic,
      stars: schema.stars ?? repo.stargazers_count ?? 0,
      forks: schema.forks ?? repo.forks_count ?? 0,
      watchers: schema.watchers ?? repo.watchers_count ?? 0,
      openIssues: schema.openIssues ?? repo.open_issues_count ?? 0,
      createdAt: finalCreatedAt,
      updatedAt: finalUpdatedAt,
    });
  }

  const statusOrder = {
    active: 1,
    building: 2,
    maintenance: 3,
    error: 4,
    archived: 5,
    disabled: 6,
  };

  finalProjects.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;

    const orderA = statusOrder[a.status] ?? 99;
    const orderB = statusOrder[b.status] ?? 99;
    if (orderA !== orderB) return orderA - orderB;

    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });

  await fs.writeFile(CONFIG_FILE, JSON.stringify(updatedConfig, null, 2));
  await fs.writeFile(PROJECTS_FILE, JSON.stringify(finalProjects, null, 2));
  console.log(
    `Berhasil mencatat ${finalProjects.length} proyek ke${PROJECTS_FILE}, memperbarui ${CONFIG_FILE}, dan menyalin ikon ke folder${ICONS_DIR}`,
  );
  await cleanupOrphanedIcons(activeIconFiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
