# Contributing

Thanks for your interest in Fabbrico!

Fabbrico is a personal project, developed in a private repository. This public repository
receives a snapshot at each release, so its history is one commit per version.

The most useful contributions are:

- **Issues**: bugs (with the steps to reproduce them and, if you can, the `.fabbrico` project),
  ideas, and prints that came out wrong although the app said they were fine.
- **Experiences**: what you learned printing a part designed with Fabbrico (tolerances, fits,
  orientations that worked). Open an issue and describe it.

Pull requests are welcome too, but they are not merged here directly: the change is brought
into the development repository by hand and appears in the next release, with credit in the
release notes. For anything larger than a small fix, please open an issue first so we can agree
on the approach.

## Running from source

```bash
./start.sh      # or: npm start
npm run build   # type-check and production build
npm run lint
```

See the [README](README.md) for how the app is organised.
