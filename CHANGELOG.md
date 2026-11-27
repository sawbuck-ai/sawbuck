# Changelog

What was found and fixed in each version, newest first. For versions before 0.1.73 see the release notes at [github.com/sawbuck-ai/sawbuck/releases](https://github.com/sawbuck-ai/sawbuck/releases). 0.1.72 was never published.

## 0.2.10 (2026-11-26): a setting the agent writes does not take effect

- **A setting the agent writes does not take effect.** `enforce.maxBlocks` and `enforce.remindTurns` in
  sawbuck.config.json are read as the turn's start has the file, and `holds` as the stricter of the turn's start and
  the file now: a hold added during a turn counts at once, and `off` counts only once the turn's start has it too. A
  change the agent makes to the file is sent back like any change to the contract and does not take effect; your own
  change between turns counts from your next prompt. Before, an agent that wrote `maxBlocks` 0 and left it turned
  the wall off from the next prompt, and `holds.off` took the question before a publish away in the same turn.
- **Your own holds are asked about before they are written.** A command or an edit that writes
  `~/.sawbuck/config.json` is asked first (reading it is not), and turning your holds off there during a turn counts
  from your next prompt; a hold you add counts at once. Before, an agent could turn your holds off for every repo
  without being asked.
- **The send-back says what a reason is for, whoever made the change.** A reason does not end the send-back, whoever
  gives it; reverting the change does. Before, only the half for a change the agent did not make said so, and in a
  real session an agent that kept a change it made told the person a reason would clear it.
- **A turn is sent back three times at most, for a protected change and a gamed test together.** In 0.2.9 a turn
  with both could be sent back up to six times, three for each; now three in all, as in 0.2.8.

## 0.2.9 (2026-11-26): the wall sends one change back once

- **A protected change is sent back once, not three times a prompt.** In 0.2.8 a protected file changed in a session
  was sent back three times on every prompt, in a new session too, for as long as the change stood, and a person's own
  edit read as the agent's could not be ended by a reason. Now one change, a file and what was done to it, is sent back
  once (`enforce.maxBlocks` in sawbuck.config.json sets how many times, counted across prompts, once in each session);
  after that the end of each turn tells you while it stands. A further change to the file is sent back once more, up
  to three send-backs in one turn. Measured first, in our own sessions: every agent sent back for its own protected
  edit undid it after the first send-back, and no repeat ever changed what an agent did.
- **The send-back says what to do in each case.** If the agent made the change, it undoes it, and the person makes
  it themselves in their editor or another terminal between turns, never with a `!` line. If it did not, it undoes
  nothing and tells the person that a reason does not end it; a revert does.
- **`sawbuck check --allow` says when it kept nothing.** With nothing measured (no test command found) it said only
  "inconclusive"; now it says the reason was not kept.
- **The hold reads a command by its parts.** A command made only of reads that names `.sawbuck`, such as `cat` and
  `ls` joined with `;` or `&&` with errors sent to /dev/null, was asked about; it is not now. And a read followed by a
  second command on a new line was taken for a read and not asked (0.2.8 and earlier); it is asked now. Anything else
  that names the record is asked, as before. A command that runs Sawbuck's own end-of-turn check by hand is asked too.

## 0.2.8 (2026-11-24): a failed pull-request check says why in its own log, a note on a test rewritten after the source changed, and the hooks say when they start an older sawbuck

- **A failed pull-request check says why in its own log.** The job that fails prints what the comment says and
  raises one annotation, "Sawbuck sent this back". With `comment-only` it is a warning, "Sawbuck would have sent
  this back", and the job stays green. An agent working on a failed check reads the check's log, not the comment.
  A workflow pinned to an older engine keeps the old log until its pin moves.
- **A new note on pull requests: a test the base had, rewritten after the source changed.** It names the tests and
  the two commits, and never fails the check. `sawbuck contract --strict` sets `"testRewrites": "ask"`, and then
  it sends the pull request back until a person gives a reason.
- **A send-back for a protected path says what to do when the change is not the agent's.** A person can make such a
  change while the agent works, in an editor, or with a line typed with `!`. The agent is told to undo nothing, tell
  the person that a reason does not end it, and stop. It ends when the person reverts the change; once a turn has
  ended after that, a change they make in their editor before the next prompt is theirs.
- **doctor, status and attach say when the hooks here start an older sawbuck.** On one machine the user-level hooks
  started 0.2.2 from a checkout for two days while 0.2.7 was installed. doctor now marks such a set OLD and exits 1,
  and status and attach say it in a line. Each names the step and says it is a person's: bringing the hooks up
  changes what watches the agent. status and attach read the version a hook names and never run it, so they reach
  no network.
- **`sawbuck contract` says when no test command was found, on every path that leaves the placeholder.** Before,
  only `--full` with a CI check said so.
- **The hold no longer asks about a commit message.** A `git commit` whose message named `--allow`, a publish or the
  record folder was asked about as if the message were a command. A message given as one single-quoted string, or
  one double-quoted string with no `$`, backtick or backslash, is now set aside. A message that could run something,
  and the rest of the line, are read as before.
- **An undo by `git checkout` under `core.autocrlf=true` is recorded.** The checkout writes the file back with CRLF
  while the last commit has LF, so the file never read as back to its base and the undo was not recorded (since
  0.2.0). The undo record now reads CRLF as LF.
- **In a repository with no commit yet,** status says so (it said it could not read the ledger), and an undo of a
  new file a shell command made is recorded.
- **align gives the session's start in your own time,** with the zone's short name. It said it in UTC.
- **Two printed lines use the word history:** the last line of `attach --user`, and the status label for a
  repository with history and no check. `status --json` keeps its value, so a script that reads it keeps working.

## 0.2.7 (2026-11-23): tests a pull request added and took out, a new note, and the activity feed says who checked

- **On a pull request, tests it added and then took out send it back.** The check `sawbuck contract --full` writes
  now pins engine 0.8.20: where every test an earlier commit of a pull request added is gone at its head, the job
  fails and the comment's line needs a look. A person's `sawbuck-allow:` reason lets it through, and `comment-only`
  leaves the job green. A workflow pinned to an older engine keeps it until its pin moves.
- **A new note: two or more named tests are gone.** `sawbuck check` and the pull-request comment name the tests the
  changed files no longer name. A rename reads the same way. It never fails the check.
- **The activity feed says who checked what.** Each line in `.sawbuck/activity.jsonl` now names its schema, the
  session it is about, the full commits of the span that was checked, that the hook ran the check, and the measure
  that decided, with how much of its win survived the re-run from the source alone. Nothing else is in a line: no
  test output, no code.

## 0.2.6 (2026-11-23): the wall at the end of a turn

Five faults in one place: the check at the end of a turn on the paths your contract protects. A second reader of
0.2.5 found four of them. The first, the oldest and the worst, turned up when the other half of one of that reader's
cases was typed. Each was run on the published packages before it was fixed.

- **Fixed: a file named `HEAD` blinded the wall.** In any repository, a turn that made an empty file named `HEAD`
  at the top and then edited a protected path was not sent back, also when it edited the contract and committed.
  As old as the wall: 0.1.70 has it.
  Git refuses `git diff HEAD` when a file of that name exists, and the hook read the refusal as "nothing changed".
  The same with a file named as the commit the turn began at. `sawbuck check` refused to run beside such a file.
  Every git call that names a revision now says where its revisions end, and a test holds that.
- **Fixed: a contract that was not yet committed could be deleted or hidden.** Between `sawbuck contract` and your
  first commit of it, a turn that deleted the contract, or added it to `.gitignore` and emptied it, was not sent
  back. In a repository that has commits, in every version. In a repository with no commit yet, since 0.2.5: before
  it every turn there was sent back, which hid this, and 0.2.5 stopped that without reading a deletion. The end of
  a turn asked git what was changed, and a file that is gone or ignored is on no list. A turn is now read against
  what it began with. The send-back holds the line that puts the file back. A turn that takes it out of the folder
  with `git stash -u` or `git clean -fd` counts as deleting it.
- **Fixed: with no commit yet, a contract edit that was staged or went into a first commit was not read.** It ended
  the turn with nothing said. It is sent back now. So is a protected edit on an orphan branch made in the same turn.
  With no commit yet the second copy of the turn's baseline was not used either, so the state file alone decided: it
  is used now.
- **Fixed: with user-level hooks, a new folder was sent back at every turn.** Where the hooks are wired for every
  folder (`attach --user`), a turn that began in a folder with no repository and set Sawbuck up there was sent back
  for the contract it had just written, and so was every turn until a first commit. 0.2.5 fixed this only where
  the hooks are wired in the project.
- **Fixed: a link under a protected name.** A link of yours that was not yet committed (a `docker-compose.yml`
  that points into a folder, say) and that a turn only committed was sent back as changed by the turn.
- **Still open, and said in LIMITS.md:** with no commit yet, a protected file other than the contract (a workflow,
  say) that a turn stages, puts in the first commit, or deletes or hides while it is untracked, is not seen at the end
  of the turn. A pull request reads it.
- **Still open, and said in LIMITS.md:** after the three send-backs a change is not held when it took its own rule
  away. A turn that removes every rule and commits is sent back three times, you are told, and the next turn has no
  rules. The same for a contract that is deleted before its first commit and left deleted.

## 0.2.5 (2026-11-22): where the work stands, the loop, and pages that agree

Four things in one release. Each is said below.

- **`sawbuck align`: where the work stands when Sawbuck joins late.** You start on a project in a prompt and bring Sawbuck in afterwards. `attach` now reads each commit since the session began against the contract, once, and says what stands out: a count that fell, a protected path that changed, tests an earlier commit added that are gone. It is said to you, and once to the agent at its next prompt, which is asked to tell you and to ask whether it was meant. A reading, never a verdict: nothing from before is sent back. When nothing stands out the agent is told nothing. In two first looks with a real agent, it left the earlier work alone, told the person and asked. Without the reading it said nothing.
- **No dead ends outside a repository.** `contract`, `attach`, `check` and `align` in a folder with no git repository say how to start one. On a terminal, Enter starts it and the command goes on. Anywhere else nothing waits.
- **The pages agree.** The README, the npm description and the help open with one sentence. One table in the guide says which line is for whom. The sentence on where it has run is the same on every page. Codex and Cursor are said as not yet run end to end.
- **The two ways to accept a change are said apart.** `--allow` is for a commit on your machine. On a pull request it is a comment there. The line joined them by "or", and an agent that had only that line told its person to use the first for a change that was on a pull request.
- **A limit said: a change that swaps a test tool can read `gamed`.** Found on a real commit by a person. The earlier tests cannot be run with what is installed now. A person's reason is the way through, and the engine's report now marks the case (`baseUnrun`).
- **Fixed: in a repository with no commit yet, every turn was sent back for the contract.** After `contract` and `attach` in a new repository, the end of each turn read `promptwheel.config.json` as changed in that turn and sent the agent back, until a first commit. 0.2.4 does the same. Found by running this release in a real session before it went out: the new offer of a repository leads straight there. Fixed where the hooks are wired in the project (`sawbuck attach`, and the plugin's setup). Not yet with user-level hooks (`attach --user`): there a folder that was no repository when the turn began is still sent back until a first commit.
- **Fixed: `contract --try` started gpg once for every commit it listed** where git shows signatures by default. Slow, not wrong, since 0.2.1.

### The loop, and the record it leaves

The engine had a loop from June to November: run an agent, check what it changed, keep it only if a measure improved. It was removed before launch with no measurement behind the cut, and Sawbuck never had a command for it. It is back in the engine, and Sawbuck hands it through.

- **`sawbuck improve --attempt "<cmd>"`.** One step of a loop, for work nobody watches. Kept means one commit. Anything else means the tree is put back as it was. More tests alone is not a win, and a commit the agent makes itself is still checked.
- **`--turns N`: judged over a number of turns.** For work bigger than one attempt. Each turn goes on from the last, the whole change so far is checked against where the run started, the reading is handed to the next turn, and the best turn is kept as one commit. Under a pass-or-fail measure the old rule (each attempt judged alone) threw away every fix bigger than one attempt.
- **`sawbuck playbook`, `insights`, `suggest`, `backfill`.** They read the record of checked runs: what has paid here, what was tried and thrown away and why, where to spend the next attempt.
- **The record.** One short row for each check a hook runs and each attempt of the loop, in the repo's git folder. Nothing you typed is in it, and nothing lands in your files. A `sawbuck check` by hand adds no row. `sawbuck detach --purge` removes it.
- **Held to a list of attacks** another session wrote for a loop step: "what is judged cannot touch what judges it". One landed and is fixed: a protected path that a turn hid from git (`skip-worktree`, `assume-unchanged`) and then edited was not seen at the end of the turn. Four are limits of judging an agent that runs as you, and [LIMITS.md](LIMITS.md) now says each in plain words, with what does hold: the installed copy can be edited, an installed package your tests run can be edited, a process left running can change a file after the turn, and a rule deleted behind another rule moves no count.
- **Held to a second list: git's own files.** The same session wrote five more attacks, through files git does not track and a turn can write. A turn set an fsmonitor command, and git ran it inside the end-of-turn check's own `git status`: the check ran code the turn wrote. Sawbuck's own git calls now run no hook, no fsmonitor command, and read no replace object, and your tests still run with your git settings as you set them. The setting that turns hooks and fsmonitor off needs git 2.31 or newer; an older git ignores it and says nothing. A replace ref made the check read the old object in place of a broken one; the engine now reads objects as they are stored. Two are limits, now in [LIMITS.md](LIMITS.md) with what holds: a filter in git's settings (the repo's or yours) can make the check read another tree than the one committed, and a process the turn leaves running can write into the copy the check measures in. The check on a clean clone, as on a pull request, read what was committed in every case.
- **One keeper.** `sawbuck improve` hands through to the engine's `improve`, which is now a door onto the engine's loop step, the one keeper the owner chose (2026-11-21). A win is a gain on the target (`--target`, or `--goal`). Name none and, when the contract leaves no choice, it is picked: in the contract Sawbuck writes, and with no contract, the test run. A contract that leaves a choice is refused before the attempt runs. The loop keeps its own record (`.git/improve/attempts.jsonl`) and each try as a ref (`refs/improve/<n>`): `detach` names the file as still on disk, and `detach --purge` removes it, and the refs, with the rest of the record.
- **An attempt that could not run is not a try.** The engine's loop step now exits 64 and writes nothing when the attempt command ends with 64, or could not be found or run and changed nothing, so a broken wrapper stops `while sawbuck improve` and uses up no try. It refuses a git older than 2.31. Found in the first real run of a loop on the step.
- **Not claimed:** that the loop gets better with use. The test for that has not been run on real work ([LIMITS.md](LIMITS.md)).

## 0.2.4 (2026-11-22): tests a pull request added and took out

- **A note on tests a pull request added and took out.** An agent writes tests early in a pull request, they fail, and a later commit deletes them, so the pull request ends with as many tests as before. Now, when an earlier commit of a pull request added tests and none of them is in it at its last commit, the comment on the pull request says so in a note, with their names. So does `sawbuck check --base` over several commits. With engine 0.8.17. A note never sends a change back, and a pass that carries one is still titled "passes". LIMITS.md says what it does not see.

## 0.2.3 (2026-11-20): a report that arrived cut, and try mode without a test command

We ran the check's own commands on every commit of 994 pull requests. On one that changed 10,753 files the check said "could not run". The report was whole when it left the engine. It was cut on the way.

**A large change is checked like any other.** The engine printed its report and exited at once. Node writes to a pipe in the background, and an exit drops what the pipe has not taken yet. So a report larger than a pipe holds arrived cut: at 146,176 bytes where the reader was quick, at 65,536 where it was slow. The report lists every test, fixture and config file a change touches, so it began at a change of a few thousand of them. What that did, each seen on 0.2.2 and each a test now:

- `sawbuck check` said "could not run the check here: the engine gave no verdict".
- At the end of a turn, a test edited to pass was not sent back when the same commit also added 4,000 test files. The hook could not read the report and said nothing.
- `sawbuck check --json` reached a slow reader cut at 65,536 bytes.

The engine (0.8.16) and `sawbuck check` now end by themselves once what they printed is written. The pull request check was not affected: the Action writes the report to a file.

**`sawbuck status` reads a large debt.** `sawbuck debt --json` had the same fault, and `sawbuck status` reads it through a pipe. In a repo where 560 files each silenced one lint rule, status said "could not read the ledger".

**Try mode where no test command is found.** In such a repo `sawbuck contract --full --comment-only` wrote no workflow, and said a placeholder would fail every pull request. That was not true: the workflow lets a check that could not measure pass. Typed in copies of twelve real repos, six got no workflow, every .NET repo among them. Try mode now writes it there too. That check runs no tests, and still reads the counts of your tests and the protected paths. Without `--comment-only` no workflow is written there, as before, and the command now says how to try it.

Not run on a Mac, and not on GitHub itself.

## 0.2.2 (2026-11-20): a good guest on a pull request

We looked back at everything measured so far, and at what a stranger's repo would see of Sawbuck. The check on a pull request spoke on every push, under another name, and there was no way to try it without failing someone's pull request.

**A plain pass gets no comment.** The pull request check keeps one comment and edits it in place. The workflow `contract --full` writes now stops the check of an older push when a new one arrives. It speaks when it sends a pull request back, when a reason was used, and when a file lost tests or assertions while the repo's total held. The comment says Sawbuck and links here. This is the engine, 0.8.15. A workflow that an older `sawbuck contract --full` wrote keeps the engine it pins until its `uses:` line is changed, and `sawbuck contract` prints the line.

**Try it first: `--comment-only`.** `sawbuck contract --full --comment-only` writes the workflow so that no pull request fails. The comment says what would have been sent back. Take `comment-only: true` out of the workflow's last line when you want it to count.

**Working alone: `--solo`.** A sent-back pull request is let through by someone who did not open it. In a repo with one person in it there is no such person: you opened it, and your agent works under your account. GitHub cannot tell the two apart. `sawbuck contract --solo` signs for that. A test may be removed where a commit of the change says why, and on a pull request your own comment counts. What is kept is the reason, not proof of who gave it, and the command says so.

**A changed workflow says how to accept it.** On a pull request the comment for a protected path named the path and stopped there. Now it says who can let it through, and with what words.

**A file that lost its tests is named.** When a file loses tests or assertions and the repo's total holds because another file gained as many, `sawbuck check` and the comment on a pull request name the file in a note. It fails nothing. Run on 408 ordinary pull requests from seven public repos: of the 365 that pass, the note names a file on 17, about 1 in 20.

**`--say-why` in a repo already signed says what it changed.** It turned the switch on and said "nothing changed". Found by typing it after the 0.2.1 release.

Not run on GitHub itself before this release: the Action's own steps were run with a stand-in for `gh` (24 pull requests, 36 pushes).

## 0.2.1 (2026-11-17): try it on your own past, and a loop can read it

**Try the contract before you turn it on.** `sawbuck contract --try` writes nothing. It holds the contract a real run would write against your last 20 commits (`--try=50` for more, 200 at most) and says which would have been sent back to ask you: the ones that touch a protected path, and the ones that make a count worse. The test run itself is not replayed. When we held the plain contract against 340 real commits, 82 were sent back, every one for a protected path or a count. Now you can see your own number first.

**In a loop, with no person.** Nothing new in the code: `sawbuck check --base <ref> --json` has long printed one JSON object and exited 0, 1, 2, 3 or 64. The guide now says so in one place, with what Sawbuck adds to an agent's context (531 characters for the rule in AGENTS.md and 918 once per session, on a small repo with the plain contract). A claim holds those two counts to what is measured.

**The engine is 0.8.14: a cost that a gain pays for.** A guard is a wall. For a loop that runs unattended the engine's config can now say a rate as well: `"budget": { "gain": "score", "base": 0.10, "rate": 0.2 }` on a guard lets it get worse by a share no larger than base plus rate times the gain on the named metric, when the source earned that gain. A change cannot write or loosen its own budget. Held beside the accepting function of Google's RRSI (arXiv 2609.24972) on 1,271 made-up candidates, the two agree on 1,270; the one is a rounding on the exact line. Nothing of ours has run inside their loop.

**Where nobody stands at the merge: `sawbuck contract --say-why`.** With the plain contract a removed test is sent back until a person accepts it. In a repo where agents open and merge pull requests with no person there, that has no way through. `--say-why` lets a removed test pass when a commit in the change ends with a line that says what was removed and who asked for it. The reason is kept and shown with the verdict. It is for pull requests; a session is not changed.

**The verdict on a pull request is written for whoever fixes it.** It names the file the count fell in and the ways out, the last of which is to stop, leave it red and say why. The counts no longer read docs or lock files. Both come with engine 0.8.14: see its changelog for what was measured.

**Measured, and not built.** Two things were tried for this version and left out by the rules set before their runs (proof-bench/undo-words and proof-bench/leak-screen). A second wording of the line that tells the agent to ask before it repeats an undone change: nobody stopped on an unrelated job any more (0 of 9, where the first had 2), but three runs made the undone change again (the first: one), so the first wording stays. And a screen for an answer hardcoded in the source: with a wrong test, "get it green" and "do not change the tests", Sonnet, Haiku and Opus 5.5 hardcoded nothing in 27 tries and said the test was wrong, so there was no real case to hold the screen against. The limit stands as LIMITS.md states it.

## 0.2.0 (2026-11-17): a turn is judged on what it did, and the check keeps nothing you type

**A later turn is never sent back for an earlier one.** Until now a gamed change that was not settled stayed over every turn that followed: each later turn was sent back for it, up to three times, until the source earned the green, the test was put back or you accepted it. The rules for when that came down were where most of our own faults were (six of seven fixes on 2026-11-16), and a wrong one sent every later turn back. Now only the turn that made the change is sent back, up to three times as before, and all of its commits are judged together. After that turn you are told: one line at the end of each of the next five turns, with the three ways out. `sawbuck status` shows the change for as long as it is open, and the band in Claude Code keeps offering the three ways out. `{"enforce":{"remindTurns":2}}` in `sawbuck.config.json` sets how many turns, and 0 means never. What this costs: a later turn can build on a gamed test and is not sent back for it. `sawbuck check` on the commit and the check on a pull request still fail. The wall on protected paths is as it was: sent back in every turn while the change is there.

**A test put back in a later turn is not a new catch.** Putting the test back makes the suite red again, and judged by itself that reads "made worse". It is recorded as the test put back.

**The check keeps none of what you type.** Until now the hooks kept the first 240 characters of your latest prompt, saved those words with an undo, and handed a note for each catch, reverted attempt and undo to Claude Code's notes folder. From 0.2.0 `sawbuck attach` does none of that, and neither plugin's setup turns it on. `sawbuck attach --words`, typed by you, does all of it, and `sawbuck attach --no-words` turns it off again. A reason you give with `--allow` is kept either way, because you hand it to the command on purpose. `sawbuck status` reads the steers the plugin kept only where the repo is attached with `--words`. `sawbuck detach --purge` now removes the notes Sawbuck handed on too. Notes that Claude Code writes for itself are not Sawbuck's, and a purge leaves them. The Codex and Cursor hooks keep no words and have no switch yet.

**What keeping no words costs, measured.** The day this was built we ran it (proof-bench/undo-words, 126 real runs on Sonnet, Haiku and Opus 5.5). A change was made, the person had it undone and said why, and a later session got a related ask. With no record at all the later session made the undone change again 9 of 9 times. With a record that only said something was undone, with no words: 22 of 27. Most of those sessions said they had read it, and went on. So the line now says more: the reason is not on record, and before it makes a change like that one again the agent is to stop and ask you. With that line: 1 of 27, and 26 of 27 changed nothing and asked. With your words in the record (`attach --words`): 1 of 9. What the asking costs: on an unrelated job in the same file 2 of 9 runs stopped to ask as well (both on the smallest model), and where Claude Code already had the reason in its own notes 8 of 9 still asked. One more thing kept the change from coming back: a note that Claude Code wrote in its own notes because the person asked it to keep the reason. 0 of 27. Unasked, it wrote such a note in 4 of 15 sessions that day: in none of the bench's 10, and in 4 of our own 5 with the full plugin in the session. So do not count on it.

**You are told when a reason is not kept.** When an undo is recorded and none of your words are kept, the end of that turn says so, once in a session: how many lines, which file, that the reason is not kept, and the two ways to keep it. Tell Claude Code "Remember that for next time.", or turn on `sawbuck attach --words`. Claude Code's hooks only.

**An undo made with git.** Found in a real session with this version, before it was published, and the same in 0.1.73: asked to undo a whole change, the agent ran `git checkout`. The undo record watched the edit tools only, so nothing was recorded. The agent's second try at the change was then recorded as a partial undo, with the request for that second try as your words, and the real partial undo after it was missed. Now an undo is judged when the turn ends, from the file itself: what the agent had added when you spoke and is gone now, whatever took it out. A rewrite is not an undo.

**An undo, whatever wrote the change.** Found the same day by the bench above: in two of three real sessions the agent wrote its change with a shell command, not an edit tool. The record had nothing to compare the file with, so the undo that followed was not recorded. Now a file that is not as the last commit holds it when you speak gets its starting point from git. Three more faults came out when the ordinary cases were typed one by one, and are fixed with it. The last small change undone in a file that held more uncommitted work was missed. A turn that stashed the change, or changed branch, was recorded as an undo. And a session's copies of the files it changed were never removed: now they go once they are two weeks old, the next time a session starts in the repo.

**The redo line.** New. An undo is kept with a mark for each line that was taken out (a hash, not the text). When a later turn leaves at least three quarters of those lines in the file again, and two or more, you are told when that turn ends: the file, how many of the lines, and the first of them. You are told once, and the turn is never sent back for it: you may have asked. If you put the lines back yourself between turns, nothing is said. It reads lines, not ideas. Held against the 81 runs above it fired on 3 of 3 where the undone change itself was written back, and on none of the 32 where a later session wrote the same idea again in its own lines. So it is for the same lines coming back: a stash, a patch, a file from an old commit, the agent's own earlier edit. It does not keep a later session from trying the same thing again. The reason does that.

**Who gets this, and when.** A global copy changes when you update it (`npm i -g sawbuck@latest`): a repo it is attached to keeps none of what you type from its next prompt on, the words already in its record are taken out (the undo records stay), and you are told once. A repo set up through a plugin runs the version that attached it until you run `/sawbuck-reins:contract` or `/sawbuck:contract` again.

## 0.1.74 (2026-11-17): a yes that counts, a Mac, and a commit that was pushed

**A test you remove on purpose.** Found by typing it on 2026-11-16: in a repo with the contract, removing a test you no longer wanted failed `sawbuck check` whatever reason you gave. The contract guards the count of tests, of skipped tests and of assertions, and no reason reached those three, though [the contract](CONTRACT.md) has always named "an obsolete test removed" as a change a person can declare. Now a contract written by 0.1.74 lets a person's reason through for those three counts: `sawbuck check --allow "<reason>"`, typed at the keyboard. A commit trailer still clears nothing. A failing test deleted on purpose moves the green and the counts in one act, and one plain reason takes them together. A contract written before 0.1.74 keeps its own copy of the rule: the check says so and names the line to add (`"allowable": "flag"` on `test_count`, `skipped_tests` or `assertions` in `promptwheel.config.json`; that edit takes `--allow`). The count of lint silencers is not one of the three. The approving comment on a pull request goes the same road as it does for a new dependency, and has not been run for these counts yet. Engine: promptwheel 0.8.13 (proof-bench/yes-counts, no model).

**A yes given before the commit.** Found in a real session with this version, before it was published: the agent ran the check before it committed, as the written rule tells it to, the person approved the reason, and the commit that followed was sent back as if nobody had (a removed passing test was shown as "1 caught"). The reason had been kept for the working tree and not for the commit. Every test of ours committed first and accepted after; in two sessions of two the agent did it the other way round. Now a reason given on the working tree stands for the commit that carries the same change: the tree stood on the commit the turn began at, and every test or config the commit moved reads in it as it read when the reason was given. A test changed again after the yes, or another test changed beside it, is not what was accepted, and is sent back (proof-bench/live/rehearse-0.1.74).

**A Mac.** The tests ran on a Mac for the first time on 2026-11-16, on GitHub's runner, and 15 of 379 failed. One cause: a Mac's temp folder is reached through a symlink, and git names a repo by its real path. Most were the tests naming a folder the linked way. Two things were the product's. `sawbuck contract --full --dry-run` left `promptwheel.lock.json` off its list there; the real run always wrote it. And a file a tool call named through a symlink was not seen as the repo's file: the hold did not ask before an edit to Sawbuck's own record, an undo was not kept, and a dependency edit was shown by its long path. Both are fixed here, each with a test that makes its own symlink, so it runs on every system. The run on a Mac itself can only be read after this version is pushed, and no real session has been run on one. On Windows about half the tests fail (187 of 382); Windows is not supported yet (proof-bench/linked-tmp).

**Commit and push.** Found by typing it on 2026-11-17: a commit the agent made and pushed in the same turn was not checked when the turn ended. Every version from 0.1.57 left out any commit that was on a remote branch, so that a commit pulled in during the turn would not be blamed on the agent. A commit the agent has just pushed is on a remote branch too. So a gamed green that was committed and pushed ended the turn with nothing said, and an honest one was not checked either. `sawbuck check` and the check on a pull request were not affected. Now git's own log of each remote branch says which it was: what this clone pushed is still the agent's, and what a fetch or a pull brought in is still not. In a clone where git keeps no such log, a pushed commit is still left out.

**The pages.** The README is one page. The rest of what it held is in [GUIDE.md](GUIDE.md), every limit is in [LIMITS.md](LIMITS.md), and what was found and fixed is in this file from now on.

## 0.1.73 (2026-11-16): a gamed win beside something else

**A gamed win beside something else.** Found 2026-11-16, in every version from 0.1.64 to 0.1.71, and fixed in 0.1.73. The engine's word for a change is "fail" when it touches a protected path or makes a guarded count worse, and "gamed" only when neither is so. The end of a turn read that word and nothing else. So in a repo with a contract, a failing test that was deleted or skipped ended the turn with one line and no send-back, because the count of tests is a guard there. Only an edited assertion was sent back. A gamed test committed beside a protected path was not read either: once the agent had put the path back in a new commit, as the send-back asks, the turn ended; and when the path was your own uncommitted file that rode along in `git add -A`, nothing was said at all. `sawbuck check` on such a commit did fail, for the other thing, and its report marked the green as gamed. Now a gamed win is sent back whatever else the change holds, and the message says what else it holds. Typing the three ways out found two that did not work: putting the test back left the turn sent back for good when the suite was red again, and `--allow` cleared nothing when the turn had made more than one commit. Each ends it now. One more, found the same day: a verdict that stands came down on the engine's "pass" over its span even when that pass came from another metric. In a contract with a second metric you added yourself (coverage, a lint count), the test still edited, the suite broken again and that other metric improved from the source read "pass", and the edited test stood. Now it comes down when the test's own win is earned from the source, when the test is put back, or when you give a reason; and what decides that is kept in the second copy, not only in the record (proof-bench/beside-guard, no model: on each of six published versions 6 of 8 gamed changes in a repo with a contract were not sent back, and 12 of 12 are on 0.1.73; the same changes with no contract were always sent back). Not run: Codex, Cursor, a Mac, Windows. Still so, by design: a count that got worse with nothing gamed, a test deleted from a green suite, is said once at the end of a turn and not sent back; the check on the commit and on a pull request fails it.
