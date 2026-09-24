// Fake credentials, assembled at runtime so the repository itself does not
// trip GitHub push protection or secret scanners.
export const FAKE_AWS_KEY = ["AKIA", "Z7Q3LXKD4TPR2VNM"].join("");
export const FAKE_PEM_HEADER = ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");
