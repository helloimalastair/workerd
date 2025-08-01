# WARNING: THIS FILE IS AUTOGENERATED BY update-deps.py DO NOT EDIT

load("@//:build/http.bzl", "http_archive")

TAG_NAME = "v1.2.0"
URL = "https://api.github.com/repos/CodSpeedHQ/codspeed-cpp/tarball/v1.2.0"
STRIP_PREFIX = "CodSpeedHQ-codspeed-cpp-719c41f"
SHA256 = "1ced2c2e813313a574f41de9a218f38b53a4114cf7e72ee286801eaba6d8b240"
TYPE = "tgz"

def dep_codspeed():
    http_archive(
        name = "codspeed",
        url = URL,
        strip_prefix = STRIP_PREFIX,
        type = TYPE,
        sha256 = SHA256,
    )
