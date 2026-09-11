#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* Observe the real close before pausing; never replace its result or journal bytes. */
static int observed_close(int descriptor) {
  const int entry_error = errno;
  char path[PATH_MAX];
  const char suffix[] = "/.vgpu-native-publication.update.json";
  int flags = fcntl(descriptor, F_GETFL);
  int update = flags >= 0 && (flags & O_ACCMODE) == O_WRONLY &&
    fcntl(descriptor, F_GETPATH, path) == 0 &&
    strlen(path) >= sizeof(suffix) - 1 &&
    strcmp(path + strlen(path) - (sizeof(suffix) - 1), suffix) == 0;
  errno = entry_error;
  const int result = close(descriptor);
  const int saved_error = errno;
  static unsigned int updates_closed = 0;
  const char *paused = getenv("VGPU_JOURNAL_CLOSED");
  const char *resume = getenv("VGPU_JOURNAL_RESUME");
  if (result == 0 && update && ++updates_closed == 2 && paused && resume) {
    int marker = open(paused, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (marker < 0 || write(marker, "closed\n", 7) != 7 || close(marker) != 0)
      _exit(90);
    struct timespec beginning, now;
    if (clock_gettime(CLOCK_MONOTONIC, &beginning) != 0) _exit(91);
    while (access(resume, F_OK) != 0) {
      if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 ||
          now.tv_sec - beginning.tv_sec >= 3) _exit(92);
      const struct timespec interval = { .tv_sec = 0, .tv_nsec = 1000000 };
      nanosleep(&interval, NULL);
    }
  }
  errno = saved_error;
  return result;
}

__attribute__((used, section("__DATA,__interpose")))
static const struct {
  int (*replacement)(int);
  int (*original)(int);
} close_observer = { observed_close, close };
