# WARNING: THIS FILE IS AUTOGENERATED BY update-deps.py DO NOT EDIT

load("@//:build/http.bzl", "http_file")

TAG_NAME = "v7.3.1"
URL = "https://github.com/bazelbuild/buildtools/releases/download/v7.3.1/buildifier-darwin-amd64"
SHA256 = "375f823103d01620aaec20a0c29c6cbca99f4fd0725ae30b93655c6704f44d71"

def dep_buildifier_darwin_amd64():
    http_file(
        name = "buildifier-darwin-amd64",
        url = URL,
        executable = True,
        sha256 = SHA256,
    )