#include <sys/stat.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static void write_marker(const char *path, const char *bytes, size_t length) {
  int marker = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (marker < 0 || write(marker, bytes, length) != (ssize_t)length || close(marker) != 0)
    _exit(90);
}

/* Pause only at the actual package syscall boundary; preserve every operand and flag. */
static int observed_renameatx_np(int from_directory, const char *from,
                                int to_directory, const char *to, unsigned int flags) {
  const char *paused = getenv("VGPU_RENAME_CONFLICT_PAUSED");
  const char *resume = getenv("VGPU_RENAME_CONFLICT_RESUME");
  const char *completed = getenv("VGPU_RENAME_CONFLICT_COMPLETED");
  static int observed = 0;
  int selected = !observed && paused && resume && completed &&
    strcmp(from, ".vgpu-native-stage") == 0 && strcmp(to, "AppShaders") == 0;
  if (selected) {
    observed = 1;
    write_marker(paused, "before-rename\n", 14);
    struct timespec beginning, now;
    if (clock_gettime(CLOCK_MONOTONIC, &beginning) != 0) _exit(91);
    while (access(resume, F_OK) != 0) {
      if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 ||
          now.tv_sec - beginning.tv_sec >= 5) _exit(92);
      const struct timespec interval = { .tv_sec = 0, .tv_nsec = 1000000 };
      nanosleep(&interval, NULL);
    }
  }
  int result = renameatx_np(from_directory, from, to_directory, to, flags);
  int saved_error = errno;
  if (selected) {
    char bytes[64];
    int length = snprintf(bytes, sizeof(bytes), "%d %d\n", result, saved_error);
    if (length < 0 || (size_t)length >= sizeof(bytes)) _exit(93);
    write_marker(completed, bytes, (size_t)length);
    const char *exit_after_success = getenv("VGPU_RENAME_EXIT_AFTER_SUCCESS");
    /* The real syscall has completed, but the helper cannot return or send its ACK. */
    if (result == 0 && exit_after_success && strcmp(exit_after_success, "1") == 0)
      _exit(97);
  }
  errno = saved_error;
  return result;
}

/* dyld redirects the helper's reference, not this fixture's real syscall call. */
__attribute__((used, section("__DATA,__interpose")))
static const struct {
  int (*replacement)(int, const char *, int, const char *, unsigned int);
  int (*original)(int, const char *, int, const char *, unsigned int);
} rename_observer = { observed_renameatx_np, renameatx_np };
