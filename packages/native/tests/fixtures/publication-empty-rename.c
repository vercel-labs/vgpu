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
  if (marker < 0) _exit(90);
  size_t used = 0;
  while (used < length) {
    ssize_t count = write(marker, bytes + used, length - used);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) _exit(90);
    used += (size_t)count;
  }
  if (close(marker) != 0) _exit(90);
}

/* Observe the actual package syscall, without changing its operands or flags. */
static int observed_renameatx_np(int from_directory, const char *from,
                                int to_directory, const char *to, unsigned int flags) {
  int entering_error = errno;
  const char *paused = getenv("VGPU_EMPTY_RENAME_PAUSED");
  const char *resume = getenv("VGPU_EMPTY_RENAME_RESUME");
  const char *completed = getenv("VGPU_EMPTY_RENAME_COMPLETED");
  static int observed = 0;
  int selected = !observed && paused && resume && completed &&
    strcmp(from, ".vgpu-native-stage") == 0 && strcmp(to, "AppShaders") == 0;
  if (selected) {
    observed = 1;
    struct stat source;
    struct stat destination;
    if (fstatat(from_directory, from, &source, AT_SYMLINK_NOFOLLOW) != 0 ||
        fstatat(to_directory, to, &destination, AT_SYMLINK_NOFOLLOW) != 0)
      _exit(91);
    char bytes[512];
    int length = snprintf(bytes, sizeof(bytes),
      "{\"flags\":%u,\"noFollowAny\":%u,"
      "\"source\":{\"device\":\"%llu\",\"inode\":\"%llu\"},"
      "\"destination\":{\"device\":\"%llu\",\"inode\":\"%llu\"}}\n",
      flags, (unsigned int)RENAME_NOFOLLOW_ANY,
      (unsigned long long)source.st_dev, (unsigned long long)source.st_ino,
      (unsigned long long)destination.st_dev, (unsigned long long)destination.st_ino);
    if (length < 0 || (size_t)length >= sizeof(bytes)) _exit(92);
    write_marker(paused, bytes, (size_t)length);
    struct timespec beginning, now;
    if (clock_gettime(CLOCK_MONOTONIC, &beginning) != 0) _exit(93);
    while (access(resume, F_OK) != 0) {
      if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 ||
          now.tv_sec - beginning.tv_sec >= 5) _exit(94);
      const struct timespec interval = { .tv_sec = 0, .tv_nsec = 1000000 };
      nanosleep(&interval, NULL);
    }
  }
  errno = entering_error;
  int result = renameatx_np(from_directory, from, to_directory, to, flags);
  int saved_error = errno;
  if (selected) {
    struct stat destination;
    int present = fstatat(to_directory, to, &destination, AT_SYMLINK_NOFOLLOW) == 0;
    if (!present && errno != ENOENT) _exit(95);
    char identity[160];
    int identity_length = present ? snprintf(identity, sizeof(identity),
      "{\"device\":\"%llu\",\"inode\":\"%llu\"}",
      (unsigned long long)destination.st_dev, (unsigned long long)destination.st_ino) :
      snprintf(identity, sizeof(identity), "null");
    if (identity_length < 0 || (size_t)identity_length >= sizeof(identity)) _exit(92);
    char bytes[256];
    int length = snprintf(bytes, sizeof(bytes),
      "{\"result\":%d,\"errno\":%d,\"destination\":%s}\n", result, saved_error, identity);
    if (length < 0 || (size_t)length >= sizeof(bytes)) _exit(92);
    write_marker(completed, bytes, (size_t)length);
  }
  errno = saved_error;
  return result;
}

/* dyld redirects the helper reference, not this fixture's real syscall call. */
__attribute__((used, section("__DATA,__interpose")))
static const struct {
  int (*replacement)(int, const char *, int, const char *, unsigned int);
  int (*original)(int, const char *, int, const char *, unsigned int);
} rename_observer = { observed_renameatx_np, renameatx_np };
