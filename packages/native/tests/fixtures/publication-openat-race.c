#include <sys/stat.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>
#include <errno.h>

/* Test-only observation: the real openat completes before the fixture pauses. */
static int observed_openat(int directory, const char *path, int flags, ...) {
  int result;
  if ((flags & O_CREAT) != 0) {
    va_list arguments;
    va_start(arguments, flags);
    mode_t mode = va_arg(arguments, int);
    va_end(arguments);
    result = openat(directory, path, flags, mode);
  } else {
    result = openat(directory, path, flags);
  }
  int saved_error = errno;
  const char *device = getenv("VGPU_RACE_ANCHOR_DEVICE");
  const char *inode = getenv("VGPU_RACE_ANCHOR_INODE");
  const char *paused = getenv("VGPU_RACE_PAUSED");
  const char *resume = getenv("VGPU_RACE_RESUME");
  static int observed = 0;
  struct stat identity;
  if (!observed && result >= 0 && device && inode && paused && resume &&
      fstat(result, &identity) == 0 &&
      (unsigned long long)identity.st_dev == strtoull(device, NULL, 10) &&
      (unsigned long long)identity.st_ino == strtoull(inode, NULL, 10)) {
    observed = 1;
    int marker = open(paused, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (marker < 0 || write(marker, "opened\n", 7) != 7 || close(marker) != 0)
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

/* dyld's interposition pair redirects external references, not the call above. */
__attribute__((used, section("__DATA,__interpose")))
static const struct {
  int (*replacement)(int, const char *, int, ...);
  int (*original)(int, const char *, int, ...);
} openat_observer = { observed_openat, openat };
