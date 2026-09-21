#include <sys/resource.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

#ifndef PUBLICATION_TEST_FILE_LIMIT
#define PUBLICATION_TEST_FILE_LIMIT 512
#endif

/* Apply a real kernel write limit, then run the unmodified staging helper. */
int main(int argc, char **argv) {
  if (argc < 2) return 125;
  const struct rlimit limit = {
    .rlim_cur = PUBLICATION_TEST_FILE_LIMIT,
    .rlim_max = PUBLICATION_TEST_FILE_LIMIT
  };
  if (signal(SIGXFSZ, SIG_IGN) == SIG_ERR || setrlimit(RLIMIT_FSIZE, &limit) != 0) {
    perror("publication file-size limit");
    return 125;
  }
  execv(argv[1], argv + 1);
  perror("publication helper exec");
  return 125;
}
