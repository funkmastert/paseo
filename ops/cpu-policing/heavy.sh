#!/bin/bash
# Runs one heavy command (npm ci/install, npm run build:*, a workspace typecheck, a vitest run)
# while holding one of two machine-wide slots, so the CPU-policing agents never run more than
# two heavy steps at once. Waits for a free slot.
#   ~/bozeo-ops/cpu-policing/heavy.sh npx vitest run src/foo.test.ts --bail=1 --maxWorkers=2
#
# A slot is a kernel lock (flock) on locks/slot<N>.lock held by this wrapper while the command
# runs. The kernel drops it the moment the wrapper exits or is killed, so there is no stale slot to
# reclaim, no reclaim race, and a reused pid can't pin one. The lock fd is close-on-exec, so a
# daemon the command leaves behind (Gradle, VBCSCompiler) doesn't keep the slot. SIGINT/SIGTERM
# are passed to the command and the slot is held until it exits. If a lock file can't be created
# (disk full, permissions) the command does not run: exit 75, never unbounded.
# HEAVY_LOCKDIR and HEAVY_SLOTS override the defaults (tests).
LOCKDIR="${HEAVY_LOCKDIR:-$HOME/bozeo-ops/cpu-policing/locks}"
SLOTS="${HEAVY_SLOTS:-2}"
if [ "$#" -eq 0 ]; then
  echo "usage: heavy.sh <command> [args...]" >&2
  exit 2
fi
if ! mkdir -p "$LOCKDIR" 2>/dev/null; then
  echo "heavy.sh: cannot create $LOCKDIR; not running the command unbounded" >&2
  exit 75
fi
exec /usr/bin/perl -e '
use strict;
use warnings;
use Fcntl qw(:flock O_RDWR O_CREAT);
use POSIX qw(:sys_wait_h);
my ($dir, $slots, @cmd) = @ARGV;
my ($child, $stop);
for my $sig (qw(INT TERM HUP)) {
  $SIG{$sig} = sub { if ($child) { kill $sig, $child } else { $stop = $sig } };
}
my $announced = 0;
while (1) {
  exit 130 if $stop;
  for my $i (1 .. $slots) {
    my $path = "$dir/slot$i.lock";
    my $fh;
    unless (sysopen($fh, $path, O_RDWR | O_CREAT, 0644)) {
      print STDERR "heavy.sh: cannot open $path: $!; not running the command unbounded\n";
      exit 75;
    }
    unless (flock($fh, LOCK_EX | LOCK_NB)) { close $fh; next; }
    exit 130 if $stop;
    if (open(my $info, ">", "$dir/slot$i.cmd")) {
      my @t = gmtime; printf $info "%04d-%02d-%02dT%02d:%02d:%02dZ\t%s\t%d\t%s\n",
        $t[5] + 1900, $t[4] + 1, @t[3, 2, 1, 0], $ENV{PWD} // "", $$, join(" ", @cmd);
      close $info;
    }
    $child = fork;
    unless (defined $child) { print STDERR "heavy.sh: fork failed: $!\n"; exit 75; }
    if ($child == 0) {
      $SIG{$_} = "DEFAULT" for qw(INT TERM HUP);
      { no warnings "exec"; exec { $cmd[0] } @cmd; }
      print STDERR "heavy.sh: cannot run $cmd[0]: $!\n";
      POSIX::_exit(127);
    }
    my $pid;
    do { $pid = waitpid($child, 0) } while ($pid == -1 && $!{EINTR});
    my $st = $?;
    unlink "$dir/slot$i.cmd";
    exit(WIFSIGNALED($st) ? 128 + WTERMSIG($st) : WEXITSTATUS($st));
  }
  unless ($announced) {
    print STDERR "heavy.sh: all $slots slots busy, waiting:\n";
    for my $i (1 .. $slots) {
      if (open(my $info, "<", "$dir/slot$i.cmd")) { print STDERR <$info>; close $info; }
    }
    $announced = 1;
  }
  sleep 5;
}
' -- "$LOCKDIR" "$SLOTS" "$@"
