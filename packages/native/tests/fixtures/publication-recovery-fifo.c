#include <sys/stat.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#ifdef PUBLICATION_RECOVERY_FIFO_OBSERVER
/* Hold the actual FIFO read-open long enough to expose its effect on a real writer. */
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
  const int saved_error = errno;
  struct stat identity;
  const char *opened = getenv("VGPU_FIFO_WRITER_OPENED");
  if (result >= 0 && opened && strcmp(path, ".vgpu-native-publication.json") == 0 &&
      fstat(result, &identity) == 0 && S_ISFIFO(identity.st_mode)) {
    struct timespec beginning, now;
    if (clock_gettime(CLOCK_MONOTONIC, &beginning) != 0) _exit(90);
    while (access(opened, F_OK) != 0) {
      if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 ||
          now.tv_sec - beginning.tv_sec >= 3) _exit(91);
      const struct timespec interval = { .tv_sec = 0, .tv_nsec = 1000000 };
      nanosleep(&interval, NULL);
    }
  }
  errno = saved_error;
  return result;
}

__attribute__((used, section("__DATA,__interpose")))
static const struct {
  int (*replacement)(int, const char *, int, ...);
  int (*original)(int, const char *, int, ...);
} openat_observer = { observed_openat, openat };
#else
/* The write-only FIFO open blocks until a real reader arrives. */
int main(int argc, char **argv) {
  if (argc != 3 || write(STDOUT_FILENO, "opening\n", 8) != 8) return 125;
  int fifo = open(argv[1], O_WRONLY | O_CLOEXEC);
  if (fifo < 0) return 126;
  int marker = open(argv[2], O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (marker < 0 || write(marker, "opened\n", 7) != 7 || close(marker) != 0) return 127;
  return close(fifo) == 0 ? 0 : 128;
}
#endif
