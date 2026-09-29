import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  type CatastropheRule,
  checkCatastrophe,
  formatCatastropheDenial,
  resolveCurrentBranchWithGit,
} from "./catastrophe-gate.js";

const HOME = "/Users/tester";
const REPO = "/Users/tester/code/app";

interface GateCase {
  command: string;
  /** Defaults to REPO. */
  cwd?: string;
  /** Current branch per directory, for pushes that name no ref. Anything unlisted is `feature/x`. */
  branches?: Record<string, string>;
  note?: string;
}

interface BlockCase extends GateCase {
  rule: CatastropheRule;
}

function fakeBranchResolver(branches: Record<string, string> = {}) {
  const calls: string[] = [];
  const resolve = async (cwd: string): Promise<string | null> => {
    calls.push(cwd);
    return branches[cwd] ?? "feature/x";
  };
  return { resolve, calls };
}

async function check(testCase: GateCase) {
  const { resolve } = fakeBranchResolver(testCase.branches);
  return checkCatastrophe(testCase.command, testCase.cwd ?? REPO, resolve, { homeDir: HOME });
}

const onMain = { [REPO]: "main" };

const MUST_BLOCK: BlockCase[] = [
  // Rewriting main with an explicit refspec.
  { command: "git push --force origin main", rule: "force-push-main" },
  { command: "git push -f origin main", rule: "force-push-main" },
  { command: "git push --force-with-lease origin main", rule: "force-push-main" },
  { command: "git push --force-with-lease=main:abc123 origin main", rule: "force-push-main" },
  {
    command: "git push --force-if-includes --force-with-lease origin main",
    rule: "force-push-main",
  },
  { command: "git push -f origin HEAD:main", rule: "force-push-main" },
  { command: "git push -f origin feature:main", rule: "force-push-main" },
  { command: "git push -f origin x:main", rule: "force-push-main" },
  { command: "git push -f origin refs/heads/main", rule: "force-push-main" },
  { command: "git push -f origin HEAD:refs/heads/main", rule: "force-push-main" },
  { command: "git push origin main --force", rule: "force-push-main", note: "flag after refspec" },
  { command: "git push -uf origin main", rule: "force-push-main", note: "bundled short flags" },
  { command: "git push -f origin feature main", rule: "force-push-main", note: "one of many" },
  { command: "git push -f upstream main", rule: "force-push-main", note: "any remote" },
  { command: "git -c push.default=current push -f origin main", rule: "force-push-main" },
  { command: "git --no-pager push --force origin main", rule: "force-push-main" },
  { command: "/usr/bin/git push -f origin main", rule: "force-push-main" },
  // `+` refspecs force without a flag.
  { command: "git push origin +main", rule: "force-push-main" },
  { command: "git push origin +HEAD:main", rule: "force-push-main" },
  { command: "git push origin +HEAD:refs/heads/main", rule: "force-push-main" },
  // Deleting main.
  { command: "git push origin --delete main", rule: "delete-main" },
  { command: "git push --delete origin main", rule: "delete-main" },
  { command: "git push origin -d main", rule: "delete-main" },
  { command: "git push origin :main", rule: "delete-main" },
  { command: "git push origin :refs/heads/main", rule: "delete-main" },
  // No refspec, or HEAD, while the current branch is main.
  { command: "git push -f", branches: onMain, rule: "force-push-main" },
  { command: "git push --force origin", branches: onMain, rule: "force-push-main" },
  { command: "git push --force-with-lease", branches: onMain, rule: "force-push-main" },
  { command: "git push --force-with-lease origin HEAD", branches: onMain, rule: "force-push-main" },
  { command: "git push origin +HEAD", branches: onMain, rule: "force-push-main" },
  { command: "git push --mirror origin", branches: onMain, rule: "force-push-main" },
  // `git -C` and `cd` move the repository the push runs in.
  { command: "git -C ../repo push -f origin main", rule: "force-push-main" },
  {
    command: "git -C ../repo push -f",
    branches: { "/Users/tester/code/repo": "main" },
    rule: "force-push-main",
  },
  {
    command: "cd /srv/site && git push --force",
    branches: { "/srv/site": "main" },
    rule: "force-push-main",
  },
  // Wrappers and nested shells.
  { command: "sudo git push -f origin main", rule: "force-push-main" },
  { command: 'bash -c "git push -f origin main"', rule: "force-push-main" },
  { command: "sh -c 'git fetch && git push -f origin main'", rule: "force-push-main" },
  { command: 'echo "git push -f origin main" | bash', rule: "force-push-main" },
  { command: "npm test && git push -f origin main", rule: "force-push-main" },
  { command: "git add -A; git commit -m wip\ngit push -f origin main", rule: "force-push-main" },

  // Recursive rm of a disk, volume or home root.
  { command: "rm -rf /", rule: "rm-disk-root" },
  { command: "rm -rf /*", rule: "rm-disk-root" },
  { command: "rm -fr /", rule: "rm-disk-root" },
  { command: "rm -Rf /", rule: "rm-disk-root" },
  { command: "rm -r -f /", rule: "rm-disk-root" },
  { command: "rm -rfv /", rule: "rm-disk-root" },
  { command: "rm --recursive --force /", rule: "rm-disk-root" },
  { command: "rm -rf -- /", rule: "rm-disk-root" },
  { command: "sudo rm -rf --no-preserve-root /", rule: "rm-disk-root" },
  { command: "sudo -u root rm -rf /", rule: "rm-disk-root" },
  { command: "/bin/rm -rf /", rule: "rm-disk-root" },
  { command: "\\rm -rf /", rule: "rm-disk-root" },
  { command: "rm -rf ~", rule: "rm-disk-root" },
  { command: "rm -rf ~/", rule: "rm-disk-root" },
  { command: "rm -rf ~/*", rule: "rm-disk-root" },
  { command: "rm -rf $HOME", rule: "rm-disk-root" },
  { command: 'rm -rf "$HOME"', rule: "rm-disk-root" },
  { command: "rm -rf ${HOME}", rule: "rm-disk-root" },
  { command: 'rm -rf "${HOME}/"', rule: "rm-disk-root" },
  { command: 'rm -rf "$HOME"/*', rule: "rm-disk-root" },
  { command: "rm -rf /Users/tester", rule: "rm-disk-root" },
  { command: "rm -rf /Users/tester/", rule: "rm-disk-root" },
  { command: "rm -rf /Users/tester/code/../../tester", rule: "rm-disk-root", note: "resolved" },
  { command: "rm -rf /users/tester", rule: "rm-disk-root", note: "APFS is case-insensitive" },
  { command: "rm -rf /Users/someone-else", rule: "rm-disk-root" },
  { command: "rm -rf /Users", rule: "rm-disk-root" },
  { command: "rm -rf /Users/*", rule: "rm-disk-root" },
  { command: "rm -rf /System", rule: "rm-disk-root" },
  { command: "rm -rf /Volumes/Macintosh\\ HD", rule: "rm-disk-root" },
  { command: 'rm -rf "/Volumes/Macintosh HD"', rule: "rm-disk-root" },
  { command: "rm -rf /Volumes/External/*", rule: "rm-disk-root" },
  { command: "rm -rf /Volumes", rule: "rm-disk-root" },
  { command: "rm -rf /System/Volumes/Data", rule: "rm-disk-root" },
  { command: "rm -rf /System/Volumes/Data/Users/tester", rule: "rm-disk-root" },
  { command: "rm -rf /tmp/x ~", rule: "rm-disk-root", note: "one of many targets" },
  { command: "rm ~ -rf", rule: "rm-disk-root", note: "GNU rm permutes flags" },
  { command: "cd / && rm -rf *", rule: "rm-disk-root" },
  { command: "cd ~ && rm -rf ./*", rule: "rm-disk-root" },
  { command: "cd; rm -rf *", rule: "rm-disk-root", note: "bare cd goes home" },
  { command: "(cd / && rm -rf *)", rule: "rm-disk-root" },
  { command: "rm -rf *", cwd: "/", rule: "rm-disk-root" },
  { command: "rm -rf *", cwd: HOME, rule: "rm-disk-root" },
  { command: 'bash -c "rm -rf /"', rule: "rm-disk-root" },
  { command: "bash -lc 'rm -rf ~'", rule: "rm-disk-root" },
  { command: "zsh -c 'cd / && rm -rf *'", rule: "rm-disk-root" },
  { command: 'eval "rm -rf /"', rule: "rm-disk-root" },
  { command: "env FOO=1 rm -rf /", rule: "rm-disk-root" },
  { command: "FOO=1 rm -rf ~", rule: "rm-disk-root" },
  { command: "nice -n 10 rm -rf ~", rule: "rm-disk-root" },
  { command: "time rm -rf /", rule: "rm-disk-root" },
  { command: "nohup rm -rf / &", rule: "rm-disk-root" },
  { command: "command rm -rf ~", rule: "rm-disk-root" },
  { command: "timeout 60 rm -rf ~", rule: "rm-disk-root" },
  { command: "echo $(rm -rf /)", rule: "rm-disk-root" },
  { command: 'echo "$(rm -rf ~)"', rule: "rm-disk-root" },
  { command: "echo `rm -rf ~`", rule: "rm-disk-root" },
  { command: "ls | xargs rm -rf ~", rule: "rm-disk-root" },
  { command: "rm -rf ~/code/tmp; rm -rf ~", rule: "rm-disk-root" },
  { command: "if true; then rm -rf /; fi", rule: "rm-disk-root" },
  { command: "bash <<'EOF'\nrm -rf /\nEOF", rule: "rm-disk-root", note: "heredoc fed to a shell" },
  { command: "sh <<< 'rm -rf ~'", rule: "rm-disk-root", note: "herestring fed to a shell" },
  { command: "printf 'rm -rf /\\n' | sh", rule: "rm-disk-root" },
  { command: "X=/; rm -rf $X", rule: "rm-disk-root", note: "assignment earlier in the line" },
  { command: "export TARGET=$HOME && rm -rf $TARGET", rule: "rm-disk-root" },

  // find that deletes a whole root.
  { command: "find / -delete", rule: "find-delete-disk-root" },
  { command: "find ~ -delete", rule: "find-delete-disk-root" },
  { command: "find $HOME -type f -delete", rule: "find-delete-disk-root" },
  { command: "find / -exec rm -rf {} \\;", rule: "find-delete-disk-root" },
  { command: "find ~/ -mindepth 1 -exec rm {} +", rule: "find-delete-disk-root" },
  { command: "find /Volumes/Backup -mindepth 1 -delete", rule: "find-delete-disk-root" },
  { command: "sudo find /Users -delete", rule: "find-delete-disk-root" },
  { command: "find -L / -depth -delete", rule: "find-delete-disk-root" },
  { command: "cd / && find . -delete", rule: "find-delete-disk-root" },

  // diskutil erase verbs.
  { command: "diskutil eraseDisk APFS Blank disk2", rule: "diskutil-erase" },
  { command: "diskutil eraseVolume APFS Untitled disk3s1", rule: "diskutil-erase" },
  { command: "diskutil erasevolume HFS+ X /dev/disk4", rule: "diskutil-erase", note: "any case" },
  { command: "diskutil zeroDisk disk2", rule: "diskutil-erase" },
  { command: "diskutil randomDisk disk2", rule: "diskutil-erase" },
  { command: "diskutil secureErase 0 disk2", rule: "diskutil-erase" },
  { command: "diskutil reformat disk2s1", rule: "diskutil-erase" },
  { command: "diskutil partitionDisk disk2 GPT APFS Data 100%", rule: "diskutil-erase" },
  { command: "diskutil apfs deleteContainer disk2", rule: "diskutil-erase" },
  { command: "sudo diskutil eraseDisk JHFS+ Wiped /dev/disk2", rule: "diskutil-erase" },

  // Writing a raw disk device.
  { command: "dd if=/dev/zero of=/dev/disk2 bs=1m", rule: "raw-disk-write" },
  { command: "sudo dd if=image.iso of=/dev/rdisk4 bs=4m", rule: "raw-disk-write" },
  { command: "dd of=/dev/sda if=/dev/urandom", rule: "raw-disk-write" },
  { command: "cat /dev/zero > /dev/disk2", rule: "raw-disk-write" },

  // Formatting a disk device.
  { command: "mkfs.ext4 /dev/sdb1", rule: "format-disk" },
  { command: "mkfs -t ext4 /dev/nvme0n1p1", rule: "format-disk" },
  { command: "sudo newfs_apfs /dev/disk5s1", rule: "format-disk" },
  { command: "newfs_hfs -v Data /dev/disk5", rule: "format-disk" },
];

const MUST_NEVER_BLOCK: GateCase[] = [
  // Tyler's list.
  { command: "git push -f origin my-feature" },
  { command: "git push --force-with-lease origin HEAD", note: "on a feature branch" },
  { command: "git push origin main" },
  { command: "git push -u origin main" },
  { command: "rm -rf node_modules" },
  { command: "rm -rf ~/code/tmp" },
  { command: "rm -rf ./dist /tmp/x" },
  { command: "find . -name '*.log' -delete" },
  { command: "diskutil list" },
  { command: "dd if=/dev/zero of=./file bs=1m count=1" },
  { command: 'echo "git push -f origin main"' },

  // Pushes that do not rewrite or delete main.
  { command: "git push", branches: onMain, note: "no force" },
  { command: "git push origin HEAD", branches: onMain, note: "no force" },
  { command: "git push -f", note: "no refspec, feature branch" },
  { command: "git push --force origin", note: "no refspec, feature branch" },
  { command: "git push --force-with-lease" },
  { command: "git push -f origin main-backup" },
  { command: "git push -f origin feature/main" },
  { command: "git push -f origin main:feature", note: "main is only the source" },
  { command: "git push -f origin HEAD:main-v2" },
  { command: "git push -f origin master", note: "only main is protected" },
  { command: "git push -f origin HEAD:master" },
  { command: "git push --force-with-lease=main origin my-feature", note: "the lease names main" },
  { command: "git push -n -f origin main", note: "dry run pushes nothing" },
  { command: "git push --dry-run --force origin main" },
  { command: "git push origin --delete old-feature" },
  { command: "git push origin :old-feature" },
  { command: "git push -f origin $BRANCH", note: "unresolvable refspec" },
  { command: "git -C ../repo push -f origin feature" },
  { command: "git push --mirror backup", note: "mirror from a feature branch" },
  { command: "git fetch -f origin main" },
  { command: "git pull --force origin main" },
  { command: "git reset --hard origin/main" },
  { command: "git branch -D main" },
  { command: "git checkout main && git push origin main" },
  { command: "git rebase main && git push -f origin my-feature" },
  { command: 'git commit -m "git push -f origin main"' },
  { command: 'gh pr comment 12 --body "never run git push -f origin main"' },
  { command: "printf '%s\\n' 'git push --force origin main' > notes.txt" },
  { command: "grep -rn 'git push -f origin main' docs/" },
  { command: "bash -c 'echo git push -f origin main'" },
  { command: "echo 'git push -f origin main' # rm -rf /" },

  // Deletes that do not wipe a disk, a volume or a home directory.
  { command: "rm -rf dist build .turbo" },
  { command: 'rm -rf "$HOME/code/tmp"' },
  { command: "rm -rf ${HOME}/Library/Caches/foo" },
  { command: "rm -rf ~/Library/Developer/Xcode/DerivedData/*" },
  { command: "rm -rf /Users/tester/code" },
  { command: "rm -rf /Volumes/Backup/old-builds" },
  { command: "rm -rf /tmp/*" },
  { command: "sudo rm -rf /opt/homebrew/Caskroom/foo" },
  { command: "rm -rf $UNKNOWN", note: "unresolvable target" },
  { command: 'rm -rf "$DIR"/*', note: "unresolvable target" },
  { command: "rm -rf $(mktemp -d)", note: "unresolvable target" },
  { command: "rm -f ~/notes.txt", note: "not recursive" },
  { command: "rm ~", note: "not recursive; rm refuses a directory" },
  { command: "rm -d ~/empty-dir" },
  { command: "rm -rf .", note: "rm refuses . and .." },
  { command: "rm -rf ..", cwd: "/Users/tester/code", note: "rm refuses . and .." },
  { command: "rm -rf ../..", cwd: "/Users/tester/code", note: "rm refuses a final .." },
  { command: "rm -rf /Users/tester/code/..", note: "rm refuses a final .." },
  { command: "rm -rf *", note: "inside a repo" },
  { command: "cd /tmp && rm -rf *" },
  { command: "cd ~/code/tmp && rm -rf *" },
  { command: "cd / | rm -rf *", note: "pipeline elements run in subshells" },
  { command: "(cd /); rm -rf *", note: "the cd stays in the subshell" },
  { command: "cd - && rm -rf *", note: "unresolvable cwd" },
  { command: 'rm -rf "~"', note: "quoted ~ is a directory literally named ~" },
  { command: "rm -rf '/*'", note: "quoted * is a file literally named *" },
  { command: "echo 'rm -rf /'" },
  { command: "echo rm -rf /" },
  { command: 'grep -r "rm -rf /" .' },
  { command: "cat > wipe.sh <<'EOF'\nrm -rf /\nEOF", note: "heredoc written to a file" },
  { command: "bash wipe.sh", note: "script contents are not visible" },
  { command: "ssh build-host 'rm -rf /'", note: "runs on another machine" },
  { command: "docker run --rm alpine rm -rf /", note: "runs in a container" },
  { command: "HOME=/tmp/fake-home; rm -rf $HOME", note: "HOME reassigned first" },

  // find without an unfiltered delete of a root.
  { command: "find ~ -name .DS_Store -delete" },
  { command: "find ~ -name node_modules -type d -prune -exec rm -rf {} +" },
  { command: "find ~ -type f -mtime +30 -path '*/Caches/*' -delete" },
  { command: "find / -name foo -print" },
  { command: "find ~/code/tmp -delete" },
  { command: "find . -delete", note: "inside a repo" },

  // Disk tools used for inspection, reads, images and RAM disks.
  { command: "diskutil info disk2" },
  { command: "diskutil unmountDisk /dev/disk4" },
  { command: "diskutil eraseVolume HFS+ RAMDisk $(hdiutil attach -nomount ram://2048)" },
  { command: "dd if=/dev/disk2 of=backup.img bs=1m", note: "reads the disk" },
  { command: "dd if=/dev/zero of=$OUT bs=1m count=1", note: "unresolvable target" },
  { command: "mkfs.ext4 disk.img", note: "formats an image file" },
  { command: "newfs_hfs -v RAM $(hdiutil attach -nomount ram://1024)" },
  { command: "ls /dev/disk*" },
  { command: "echo hi > /dev/null 2>&1" },
];

describe("catastrophe gate: must block", () => {
  test.each(MUST_BLOCK)("$command", async (testCase) => {
    const decision = await check(testCase);
    expect(decision).toMatchObject({ block: true, rule: testCase.rule });
  });
});

describe("catastrophe gate: must never block", () => {
  test.each(MUST_NEVER_BLOCK)("$command", async (testCase) => {
    expect(await check(testCase)).toEqual({ block: false });
  });
});

describe("catastrophe gate: branch lookup", () => {
  test("looks up the branch only for a force push that names no ref", async () => {
    const { resolve, calls } = fakeBranchResolver();

    await checkCatastrophe("rm -rf node_modules && git push origin main", REPO, resolve, {
      homeDir: HOME,
    });
    await checkCatastrophe("git push -f origin my-feature", REPO, resolve, { homeDir: HOME });
    expect(calls).toEqual([]);

    await checkCatastrophe("git -C ../repo push --force", REPO, resolve, { homeDir: HOME });
    expect(calls).toEqual(["/Users/tester/code/repo"]);
  });

  test("allows the push when the branch cannot be resolved", async () => {
    const decision = await checkCatastrophe("git push -f", REPO, async () => null, {
      homeDir: HOME,
    });
    expect(decision).toEqual({ block: false });
  });
});

describe("catastrophe gate: real repository", () => {
  let root: string;
  let mainRepo: string;
  let featureRepo: string;

  function git(cwd: string, ...args: string[]) {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      stdio: "ignore",
    });
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "catastrophe-gate-")));
    mainRepo = path.join(root, "on-main");
    featureRepo = path.join(root, "on-feature");
    for (const repo of [mainRepo, featureRepo]) {
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    }
    git(featureRepo, "checkout", "-q", "-b", "my-feature");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("blocks a force push with no refspec while main is checked out", async () => {
    const decision = await checkCatastrophe("git push -f", mainRepo, resolveCurrentBranchWithGit);
    expect(decision).toMatchObject({ block: true, rule: "force-push-main" });
  });

  test("allows the same push on a feature branch", async () => {
    const decision = await checkCatastrophe(
      "git push -f",
      featureRepo,
      resolveCurrentBranchWithGit,
    );
    expect(decision).toEqual({ block: false });
  });

  test("honours git -C when the call's cwd is on another branch", async () => {
    const decision = await checkCatastrophe(
      "git -C ../on-main push --force-with-lease origin HEAD",
      featureRepo,
      resolveCurrentBranchWithGit,
    );
    expect(decision).toMatchObject({ block: true, rule: "force-push-main" });
  });

  test("allows the push outside a repository", async () => {
    expect(await resolveCurrentBranchWithGit(root)).toBeNull();
    expect(await checkCatastrophe("git push -f", root, resolveCurrentBranchWithGit)).toEqual({
      block: false,
    });
  });
});

describe("catastrophe gate: denial text", () => {
  test("names the rule and the command, forbids workarounds and points at Tyler", async () => {
    const command = "git push -f origin main";
    const decision = await check({ command });
    if (!decision.block) throw new Error("expected a block");

    const text = formatCatastropheDenial(decision, command);

    expect(text).toContain("force-push-main");
    expect(text).toContain(command);
    expect(text).toMatch(/final/i);
    expect(text).toMatch(/do not work around/i);
    expect(text).toMatch(/ask Tyler/);
  });
});
