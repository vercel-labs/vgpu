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

static void wait_for_marker(const char *path) {
  struct timespec beginning, now;
  if (clock_gettime(CLOCK_MONOTONIC, &beginning) != 0) _exit(93);
  while (access(path, F_OK) != 0) {
    if (errno != ENOENT || clock_gettime(CLOCK_MONOTONIC, &now) != 0 ||
        now.tv_sec - beginning.tv_sec >= 5) _exit(94);
    const struct timespec interval = { .tv_sec = 0, .tv_nsec = 1000000 };
    nanosleep(&interval, NULL);
  }
}

/* Observe both sides of the real exchange; preserve the syscall's operands and result. */
static int observed_renameatx_np(int from_directory, const char *from,
                                int to_directory, const char *to, unsigned int flags) {
  int entering_error = errno;
  const char *paused = getenv("VGPU_OWNED_RENAME_PAUSED");
  const char *resume = getenv("VGPU_OWNED_RENAME_RESUME");
  const char *completed = getenv("VGPU_OWNED_RENAME_COMPLETED");
  const char *return_after_success = getenv("VGPU_OWNED_RENAME_RETURN");
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
      "{\"flags\":%u,\"swap\":%u,\"noFollowAny\":%u,"
      "\"source\":{\"device\":\"%llu\",\"inode\":\"%llu\"},"
      "\"destination\":{\"device\":\"%llu\",\"inode\":\"%llu\"}}\n",
      flags, (unsigned int)RENAME_SWAP, (unsigned int)RENAME_NOFOLLOW_ANY,
      (unsigned long long)source.st_dev, (unsigned long long)source.st_ino,
      (unsigned long long)destination.st_dev, (unsigned long long)destination.st_ino);
    if (length < 0 || (size_t)length >= sizeof(bytes)) _exit(92);
    write_marker(paused, bytes, (size_t)length);
    wait_for_marker(resume);
  }
  errno = entering_error;
  int result = renameatx_np(from_directory, from, to_directory, to, flags);
  int saved_error = errno;
  if (selected) {
    struct stat source;
    struct stat destination;
    if (fstatat(from_directory, from, &source, AT_SYMLINK_NOFOLLOW) != 0 ||
        fstatat(to_directory, to, &destination, AT_SYMLINK_NOFOLLOW) != 0)
      _exit(95);
    char bytes[512];
    int length = snprintf(bytes, sizeof(bytes),
      "{\"result\":%d,\"errno\":%d,"
      "\"source\":{\"device\":\"%llu\",\"inode\":\"%llu\"},"
      "\"destination\":{\"device\":\"%llu\",\"inode\":\"%llu\"}}\n",
      result, saved_error,
      (unsigned long long)source.st_dev, (unsigned long long)source.st_ino,
      (unsigned long long)destination.st_dev, (unsigned long long)destination.st_ino);
    if (length < 0 || (size_t)length >= sizeof(bytes)) _exit(92);
    write_marker(completed, bytes, (size_t)length);
    if (result == 0 && return_after_success) wait_for_marker(return_after_success);
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
