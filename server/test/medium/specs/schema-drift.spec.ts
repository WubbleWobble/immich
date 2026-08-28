import { asHuman } from '@immich/sql-tools';
import { ConfigRepository } from 'src/repositories/config.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { getKyselyDB } from 'test/utils';

// The medium-test template database is built by actually running the migrations, so
// comparing it against the schema derived from the table definitions catches migrations
// that disagree with the code: missing indexes, undeclared constraints, absent comments.
// The fork learned this the hard way - `immich-admin schema-check` found five such
// mismatches in fork tables only after the first production upgrade, because nothing in
// the unit/medium/e2e chain compared the two.
describe('schema drift', () => {
  it('the migrations produce exactly the schema the table definitions declare', async () => {
    const db = await getKyselyDB('driftcheck');
    const previousUrl = process.env.DB_URL;
    process.env.DB_URL = process.env.IMMICH_TEST_POSTGRES_URL!.replace('/mich', '/immich_driftcheck');

    try {
      const repository = new DatabaseRepository(db as never, LoggingRepository.create(), new ConfigRepository());
      const drift = await repository.getSchemaDrift();
      expect(drift.items.map((item) => `${item.type}: ${asHuman(item)}`)).toEqual([]);
    } finally {
      process.env.DB_URL = previousUrl;
    }
  });
});
