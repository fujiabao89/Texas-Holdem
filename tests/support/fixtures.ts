/**
 * 通用 Fixture / Test Builder 基础（TEX-12）。
 *
 * 约定（docs/06-testing-strategy.md §3.4）：
 * - Fixture 通过公开的 Engine/协议入口构造场景，禁止篡改被测模块私有状态；
 * - 定义优先于构造：`validate` 提供运行时校验（类型校验由 TypeScript 泛型承担），
 *   待 `packages/protocol` 落地后应升级为协议 Schema 校验（见 tests/support/README.md）；
 * - Builder 不可变：`with()` 返回新实例，基础 Builder 可被多个测试安全复用；
 * - `build()` 聚合全部校验问题后一次性抛出，错误信息包含 Fixture 名与字段路径。
 */

export interface FixtureIssue {
  /** 问题字段路径，如 `players[2].stack`。 */
  readonly path: string;
  readonly message: string;
}

export class FixtureValidationError extends Error {
  readonly fixtureName: string;
  readonly issues: readonly FixtureIssue[];

  constructor(fixtureName: string, issues: readonly FixtureIssue[]) {
    const detail = issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n");
    super(`Fixture "${fixtureName}" 校验失败（${issues.length} 个问题）：\n${detail}`);
    this.name = "FixtureValidationError";
    this.fixtureName = fixtureName;
    this.issues = issues;
  }
}

export type FixtureValidator<T> = (value: T) => readonly FixtureIssue[];

export interface FixtureDefinition<T> {
  /** 人类可读的 Fixture 名，出现在校验错误中。 */
  readonly name: string;
  /** 完整默认值；`with()` 在其上做顶层浅合并。 */
  readonly defaults: () => T;
  /** 可选运行时校验；返回空数组表示通过。 */
  readonly validate?: FixtureValidator<T>;
}

export interface FixtureBuilder<T> {
  readonly name: string;
  /** 返回携带覆盖值的新 Builder；原 Builder 不受影响。 */
  with(overrides: Partial<T>): FixtureBuilder<T>;
  /** 合并默认值与覆盖值并执行校验；失败抛出 `FixtureValidationError`。 */
  build(): T;
}

export function defineFixture<T>(definition: FixtureDefinition<T>): FixtureBuilder<T> {
  const { name, defaults, validate } = definition;

  function make(overrides: Partial<T>): FixtureBuilder<T> {
    return {
      name,
      with(nextOverrides: Partial<T>): FixtureBuilder<T> {
        return make({ ...overrides, ...nextOverrides });
      },
      build(): T {
        const value: T = { ...defaults(), ...overrides };
        const issues = validate ? validate(value) : [];
        if (issues.length > 0) {
          throw new FixtureValidationError(name, issues);
        }
        return value;
      },
    };
  }

  return make({});
}
