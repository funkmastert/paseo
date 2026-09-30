"""Tests for push-scan.py against real throwaway repos: python3 ~/bozeo-ops/push-scan_test.py"""
import os, shutil, subprocess, tempfile, unittest

SCAN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "push-scan.py")
OWN = "me@own-identity.dev"  # push-scan:allow
REAL_SECRET = "apikey_" + "r3alValueThatOnlyLivesOnThisMachine0123456789abcdefXYZ"


class PushScan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="push-scan-")
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(os.path.join(self.home, "bozeo-ops"))
        os.makedirs(os.path.join(self.home, ".config/paseo"))
        with open(os.path.join(self.home, "bozeo-ops/push-scan-identities.txt"), "w") as f:
            f.write("# test\nsecret.person@gmail.com\nMyPhone-Serial-9X7Y\n")  # push-scan:allow
        with open(os.path.join(self.home, ".config/paseo/jev.env"), "w") as f:
            f.write(f"PASEO_JEV_API_KEY={REAL_SECRET}\n")
        with open(os.path.join(self.home, ".gitconfig"), "w") as f:
            f.write(f"[user]\n\temail = {OWN}\n\tname = Me\n"
                    f"[hook \"bozeo-push-scan\"]\n\tevent = pre-push\n\tcommand = python3 {SCAN}\n")
        self.env = {**os.environ, "HOME": self.home, "GIT_CONFIG_NOSYSTEM": "1"}
        self.env.pop("GIT_CONFIG_GLOBAL", None)
        self.remote = os.path.join(self.tmp, "remote.git")
        self.git("init", "-q", "--bare", self.remote, cwd=self.tmp)
        self.repo = os.path.join(self.tmp, "repo")
        self.git("clone", "-q", self.remote, self.repo, cwd=self.tmp)
        self.commit("README.md", "hello\n")
        self.push()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def git(self, *args, cwd=None, check=True):
        r = subprocess.run(["git", *args], cwd=cwd or self.repo, env=self.env, capture_output=True, text=True)
        if check and r.returncode != 0:
            raise AssertionError(f"git {args} failed: {r.stderr}")
        return r

    def commit(self, name, content, author=None, message="change"):
        with open(os.path.join(self.repo, name), "a") as f:
            f.write(content)
        self.git("add", name)
        extra = ["--author", author] if author else []
        self.git("commit", "-q", "-m", message, *extra)

    def push(self):
        return self.git("push", "-q", "origin", "HEAD", check=False)

    def assertBlocked(self, kind=None):
        r = self.push()
        self.assertNotEqual(r.returncode, 0, "push should be blocked")
        self.assertIn("push-scan: BLOCKED", r.stderr)
        if kind:
            self.assertIn(kind, r.stderr)
        return r

    def assertAllowed(self):
        r = self.push()
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_clean_push_passes(self):
        self.commit("a.txt", "nothing personal here\n")
        self.assertAllowed()

    def test_real_looking_email_in_own_commit_is_blocked(self):
        self.commit("a.txt", "ping jordan.smith@gmail.com\n")  # push-scan:allow
        self.assertBlocked("real-looking email address")

    def test_fake_email_passes(self):
        self.commit("a.txt", "ping someone@example.com and x@db.internal\n")
        self.assertAllowed()

    def test_allow_marker_skips_pattern_layer(self):
        self.commit("a.txt", "ping jordan.smith@gmail.com  # push-scan:allow\n")
        self.assertAllowed()

    def test_upstream_authored_email_passes_pattern_layer(self):
        self.commit("a.txt", "maintainer i@izs.me\n", author="Upstream <up@stream.dev>")  # push-scan:allow
        self.assertAllowed()

    def test_identity_blocked_even_from_another_author(self):
        self.commit("a.txt", "mail secret.person@gmail.com\n", author="Upstream <up@stream.dev>")  # push-scan:allow
        self.assertBlocked("Tyler's personal identifier")

    def test_identity_blocked_even_with_allow_marker(self):
        self.commit("a.txt", "device MyPhone-Serial-9X7Y  # push-scan:allow example\n")
        self.assertBlocked("Tyler's personal identifier")

    def test_real_secret_blocked_and_never_printed(self):
        self.commit("config.test.ts", f'const k = "{REAL_SECRET}"; // fake example\n', author="Up <up@stream.dev>")  # push-scan:allow
        r = self.assertBlocked("real secret from this machine")
        self.assertNotIn(REAL_SECRET, r.stderr + r.stdout)
        self.assertNotIn(REAL_SECRET[8:30], r.stderr + r.stdout)

    def test_physical_adb_serial_blocked_emulator_passes(self):
        self.commit("a.ts", 'run("adb -s emulator-5554 shell ls")\n')
        self.assertAllowed()
        self.commit("b.ts", 'run("adb -s R5CT30XYZ12 shell ls")\n')  # push-scan:allow
        self.assertBlocked("adb-serial")

    def test_obviously_fake_token_passes(self):
        self.commit("a.test.ts", 'const k = "apikey_fake-typesafe-key-do-not-use";\n')
        self.assertAllowed()

    def test_token_shaped_secret_blocked(self):
        self.commit("a.ts", 'const t = "ghp_' + "Q" * 36 + '";\n')
        self.assertBlocked("github-token")

    def test_secret_format_in_test_file_passes(self):
        self.commit("a.test.ts", 'const t = "ghp_' + "Q" * 36 + '";\n')
        self.assertAllowed()

    def test_email_in_test_file_still_blocked(self):
        self.commit("a.test.ts", 'const who = "jordan.smith@gmail.com";\n')  # push-scan:allow
        self.assertBlocked("real-looking email address")

    def test_git_host_userinfo_passes(self):
        self.commit("a.ts", 'const u = "https://token@GitHub.com/org/repo";\n')  # push-scan:allow
        self.assertAllowed()

    def test_identity_in_commit_message_blocked(self):
        self.commit("a.txt", "x\n", message="fix for secret.person@gmail.com")  # push-scan:allow
        self.assertBlocked("(message)")

    def test_merge_resolution_is_scanned(self):
        self.git("checkout", "-q", "-b", "side")
        self.commit("m.txt", "side\n")
        self.git("checkout", "-q", "-")
        self.commit("m.txt", "main\n")
        self.git("merge", "-q", "side", check=False)
        with open(os.path.join(self.repo, "m.txt"), "w") as f:
            f.write("hello\nresolved by jordan.smith@gmail.com\n")  # push-scan:allow
        self.git("add", "m.txt")
        self.git("commit", "-q", "--no-edit")
        self.assertBlocked("real-looking email address")

    def test_new_branch_scans_only_unpushed_commits(self):
        self.commit("a.txt", "clean\n")
        self.assertAllowed()
        self.git("checkout", "-q", "-b", "feature")
        self.commit("b.txt", "also clean\n")
        r = self.git("push", "-q", "origin", "feature", check=False)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_wonderly_remote_is_not_scanned(self):
        company = os.path.join(self.tmp, "git.wonderly.info", "repo.git")
        os.makedirs(os.path.dirname(company))
        self.git("init", "-q", "--bare", company, cwd=self.tmp)
        self.git("remote", "add", "company", company)
        self.commit("a.txt", "ping jordan.smith@wonderly.com\n")  # push-scan:allow
        r = self.git("push", "-q", "company", "HEAD", check=False)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_hooks_dir_copy_steps_aside_when_config_hook_runs(self):
        r = subprocess.run(["python3", SCAN, "origin", self.remote, "--from-hooks-dir"], cwd=self.repo,
                           env=self.env, input="refs/heads/x " + "1" * 40 + " refs/heads/x " + "0" * 40 + "\n",
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
